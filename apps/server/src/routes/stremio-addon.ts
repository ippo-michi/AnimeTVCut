import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  InvalidVirtualStremioIdError,
  MetadataStremioError,
  MetadataStremioUnavailableError,
} from "@animetvcut/stremio";

import {
  MediaFlowSourceError,
  MediaFlowUnavailableError,
} from "../services/mediaflow/errors.js";
import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
  StremioManifestCompatibilityError,
  StremioManifestInvalidError,
  StremioStreamResponseInvalidError,
  StremioUpstreamUnavailableError,
} from "../services/stremio-upstream/errors.js";
import type { TvCutCatalogService } from "../services/tv-cut-catalog-service.js";

export const ANIMETVCUT_VERSION = "0.2.0";

const LEGACY_ADDON_ID = "org.animetvcut.addon";
const REPAIRED_ADDON_ID = "org.animetvcut.addon.v2";
const LEGACY_CATALOG_ID = "animetvcut";
const REPAIRED_CATALOG_ID = "animetvcut-v2";
const REPAIRED_BASE_PATH = "/v2";

type PublicResourceType = "manifest" | "catalog" | "meta" | "stream" | "other";

interface PublicRequestDiagnostics {
  resourceType: PublicResourceType;
  catalogId?: string;
  search?: string;
  skip?: number;
  virtualIdPrefix?: string;
  itemCount?: number;
  aborted: boolean;
  logged: boolean;
  startedAt: number;
}

const diagnosticsByRequest = new WeakMap<
  FastifyRequest,
  PublicRequestDiagnostics
>();

function requestDiagnostics(request: FastifyRequest): PublicRequestDiagnostics {
  let diagnostics = diagnosticsByRequest.get(request);
  if (diagnostics === undefined) {
    diagnostics = {
      resourceType: "other",
      aborted: false,
      logged: false,
      startedAt: Date.now(),
    };
    diagnosticsByRequest.set(request, diagnostics);
  }
  return diagnostics;
}

function virtualIdPrefix(id: string): string {
  for (const prefix of ["atc:tv:", "atc:season:", "atc:series:"]) {
    if (id.startsWith(prefix)) return prefix;
  }
  if (id.startsWith("atc:")) return "atc:";
  return "other";
}

function metadataStatDeltas(
  before:
    | Readonly<{
        manifestRequests: number;
        catalogRequests: number;
        metaRequests: number;
      }>
    | undefined,
  after:
    | Readonly<{
        manifestRequests: number;
        catalogRequests: number;
        metaRequests: number;
      }>
    | undefined,
):
  | {
      manifestRequestsDelta: number;
      catalogRequestsDelta: number;
      metaRequestsDelta: number;
    }
  | undefined {
  if (before === undefined || after === undefined) return undefined;
  return {
    manifestRequestsDelta: after.manifestRequests - before.manifestRequests,
    catalogRequestsDelta: after.catalogRequests - before.catalogRequests,
    metaRequestsDelta: after.metaRequests - before.metaRequests,
  };
}

function disableClientCaching(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store, max-age=0");
  void reply.header("pragma", "no-cache");
  void reply.header("expires", "0");
}

function addonManifest(id: string, catalogId: string) {
  return {
    id,
    version: ANIMETVCUT_VERSION,
    name: "AnimeTVCut",
    description: "Automatic TV, season, and complete series cuts",
    resources: [
      { name: "catalog", types: ["series"] },
      {
        name: "meta",
        types: ["series"],
        idPrefixes: ["atc:tv:", "atc:season:", "atc:series:"],
      },
      {
        name: "stream",
        types: ["series"],
        idPrefixes: ["atc:tv:", "atc:season:", "atc:series:"],
      },
    ],
    types: ["series"],
    idPrefixes: ["atc:tv:", "atc:season:", "atc:series:"],
    catalogs: [
      {
        type: "series",
        id: catalogId,
        name: "AnimeTVCut",
        extra: [{ name: "search", isRequired: true }],
      },
    ],
    behaviorHints: { configurable: false },
  };
}

function parseExtra(extra: string): {
  search?: string;
  skip: number;
  skipValid: boolean;
} {
  const params = new URLSearchParams(extra);
  const search = params.get("search") ?? undefined;
  const rawSkip = params.get("skip");
  const skip = rawSkip === null ? 0 : Number(rawSkip);
  return {
    ...(search === undefined ? {} : { search }),
    skip,
    skipValid: Number.isSafeInteger(skip) && skip >= 0 && skip <= 10_000,
  };
}

function isResolvableStreamFailure(error: unknown): boolean {
  return (
    error instanceof InvalidVirtualStremioIdError ||
    error instanceof NoUsableStreamsError ||
    error instanceof NoConsistentStreamFamilyError ||
    error instanceof StremioManifestInvalidError ||
    error instanceof StremioManifestCompatibilityError ||
    error instanceof StremioStreamResponseInvalidError ||
    error instanceof StremioUpstreamUnavailableError ||
    error instanceof MediaFlowSourceError
  );
}

function infrastructureStatus(error: unknown): number {
  if (
    error instanceof MetadataStremioUnavailableError ||
    error instanceof MediaFlowUnavailableError
  ) {
    return 503;
  }
  return error instanceof MetadataStremioError ? 502 : 503;
}

export function publicStremioRoutes(
  service: TvCutCatalogService,
  options?: { routeTimeoutMs?: number },
): FastifyPluginAsync {
  const routeTimeoutMs = options?.routeTimeoutMs ?? 30_000;
  return async (app) => {
    // Instrument every public Stremio request so the full client sequence
    // can be reconstructed: manifest, catalog, meta, and stream requests
    // are all logged with requestId, resource type, path shape, and the
    // request-specific detail fields. Never log credentials, authentication
    // query strings, cookies, or the private metadata URL.
    app.addHook("onRequest", async (request, reply) => {
      const diagnostics = requestDiagnostics(request);
      request.raw.on("aborted", () => {
        diagnostics.aborted = true;
      });
      // A reply whose socket closed without the response being written is a
      // client disconnect; onResponse never fires for it, so log it here.
      reply.raw.on("close", () => {
        if (reply.raw.writableEnded || diagnostics.logged) return;
        diagnostics.logged = true;
        diagnostics.aborted = true;
        request.log.info(
          {
            requestId: request.id,
            method: request.method,
            resourceType: diagnostics.resourceType,
            ...(diagnostics.catalogId === undefined
              ? {}
              : { catalogId: diagnostics.catalogId }),
            path: request.url.split("?")[0] ?? request.url,
            ...(diagnostics.search === undefined
              ? {}
              : { search: diagnostics.search }),
            ...(diagnostics.skip === undefined
              ? {}
              : { skip: diagnostics.skip }),
            ...(diagnostics.virtualIdPrefix === undefined
              ? {}
              : { virtualIdPrefix: diagnostics.virtualIdPrefix }),
            status: reply.raw.statusCode,
            elapsedMs: Date.now() - diagnostics.startedAt,
            itemCount: diagnostics.itemCount ?? 0,
            aborted: true,
          },
          "Public Stremio request aborted",
        );
      });
    });
    app.addHook("onResponse", async (request, reply) => {
      const diagnostics = requestDiagnostics(request);
      if (diagnostics.logged) return;
      diagnostics.logged = true;
      request.log.info(
        {
          requestId: request.id,
          method: request.method,
          resourceType: diagnostics.resourceType,
          ...(diagnostics.catalogId === undefined
            ? {}
            : { catalogId: diagnostics.catalogId }),
          path: request.url.split("?")[0] ?? request.url,
          ...(diagnostics.search === undefined
            ? {}
            : { search: diagnostics.search }),
          ...(diagnostics.skip === undefined ? {} : { skip: diagnostics.skip }),
          ...(diagnostics.virtualIdPrefix === undefined
            ? {}
            : { virtualIdPrefix: diagnostics.virtualIdPrefix }),
          status: reply.statusCode,
          elapsedMs: reply.elapsedTime,
          itemCount: diagnostics.itemCount ?? 0,
          aborted: diagnostics.aborted,
        },
        "Public Stremio request finished",
      );
    });

    app.addHook("onSend", async (_request, reply, payload) => {
      void reply.header("access-control-allow-origin", "*");
      void reply.header("access-control-allow-methods", "GET, OPTIONS");
      void reply.header("access-control-allow-headers", "Accept, Content-Type");
      return payload;
    });

    const optionsHandler = async (
      _request: unknown,
      reply: { code: (code: number) => { send: () => unknown } },
    ) => reply.code(204).send();
    app.options("/manifest.json", optionsHandler);
    app.options("/manifest-v2.json", optionsHandler);
    app.options(`${REPAIRED_BASE_PATH}/manifest.json`, optionsHandler);
    app.options("/catalog/series/animetvcut.json", optionsHandler);
    app.options("/catalog/series/animetvcut/:extra.json", optionsHandler);
    app.options("/catalog/series/animetvcut-v2.json", optionsHandler);
    app.options("/catalog/series/animetvcut-v2/:extra.json", optionsHandler);
    app.options("/meta/series/:id.json", optionsHandler);
    app.options("/stream/series/:id.json", optionsHandler);
    app.options(
      `${REPAIRED_BASE_PATH}/catalog/series/animetvcut-v2.json`,
      optionsHandler,
    );
    app.options(
      `${REPAIRED_BASE_PATH}/catalog/series/animetvcut-v2/:extra.json`,
      optionsHandler,
    );
    app.options(`${REPAIRED_BASE_PATH}/meta/series/:id.json`, optionsHandler);
    app.options(`${REPAIRED_BASE_PATH}/stream/series/:id.json`, optionsHandler);

    app.get("/manifest.json", async (request, reply) => {
      disableClientCaching(reply);
      const manifest = addonManifest(LEGACY_ADDON_ID, LEGACY_CATALOG_ID);
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "manifest";
      diagnostics.itemCount = manifest.catalogs.length;
      return manifest;
    });
    // A separate standards-compatible identity is intentional. Stremio may
    // retain a poisoned catalog registration without issuing another HTTP
    // request; installing this manifest creates a clean client-side record.
    app.get("/manifest-v2.json", async (request, reply) => {
      disableClientCaching(reply);
      const manifest = addonManifest(REPAIRED_ADDON_ID, REPAIRED_CATALOG_ID);
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "manifest";
      diagnostics.itemCount = manifest.catalogs.length;
      return manifest;
    });
    app.get(`${REPAIRED_BASE_PATH}/manifest.json`, async (request, reply) => {
      disableClientCaching(reply);
      const manifest = addonManifest(REPAIRED_ADDON_ID, REPAIRED_CATALOG_ID);
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "manifest";
      diagnostics.itemCount = manifest.catalogs.length;
      return manifest;
    });

    const emptyCatalog = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      disableClientCaching(reply);
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "catalog";
      diagnostics.itemCount = 0;
      return { metas: [] };
    };
    const searchCatalog =
      (catalogId: string) =>
      async (
        request: FastifyRequest<{ Params: { extra: string } }>,
        reply: FastifyReply,
      ) => {
        // Public catalog requests must never hang indefinitely. Apply a
        // route-level timeout as a final hard deadline and propagate
        // client disconnect so upstream work is cancelled promptly.
        const abortController = new AbortController();
        const routeTimeout = AbortSignal.timeout(routeTimeoutMs);
        const combinedSignal = AbortSignal.any([
          abortController.signal,
          routeTimeout,
        ]);
        // Observe both request-side and response-side disconnect events.
        // Use named one-shot handlers so they can be removed in finally.
        const onRequestAborted = () => abortController.abort();
        const onResponseFinished = () => abortController.abort();
        request.raw.on("aborted", onRequestAborted);
        reply.raw.on("close", onResponseFinished);
        const startedAt = Date.now();
        const extra = parseExtra(request.params.extra);
        const diagnostics = requestDiagnostics(request);
        diagnostics.resourceType = "catalog";
        diagnostics.catalogId = catalogId;
        if (extra.search !== undefined) diagnostics.search = extra.search;
        diagnostics.skip = extra.skip;
        const statsBefore = service.metadataStats;
        // Diagnostic entry covering both the success and failure paths.
        // Never log credentials, authentication query parameters, cookies,
        // the private metadata URL, or its query string.
        const finishLog = (
          resultCount: number,
          outcome:
            "success" | "empty" | "metadata_error" | "timeout" | "cancelled",
        ) => {
          const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
          diagnostics.itemCount = resultCount;
          request.log.info(
            {
              requestId: request.id,
              catalogId,
              skip: extra.skip,
              elapsedMs: Date.now() - startedAt,
              resultCount,
              outcome,
              ...(deltas === undefined ? {} : deltas),
            },
            "Public catalog search finished",
          );
        };
        try {
          disableClientCaching(reply);
          if (extra.search === undefined || extra.search.trim().length === 0) {
            finishLog(0, "empty");
            return { metas: [] };
          }
          // Search results are bounded by the metadata addon (a single
          // page of results). The `skip` extra is intentionally not
          // advertised; forwarding it upstream would skip unrelated
          // source shows. Accept only page-zero requests and answer any
          // legacy `skip > 0` deterministically without touching upstream.
          if (!extra.skipValid || extra.skip > 0) {
            finishLog(0, "empty");
            return { metas: [] };
          }
          // Race the search against the route timeout as a hard deadline.
          // If service.search() ignores cancellation, the timeout wins.
          // When the timeout wins, abort the controller to propagate
          // cancellation to downstream code.
          const searchPromise = service.search(extra.search, combinedSignal);
          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            routeTimeout.addEventListener(
              "abort",
              () => {
                // Abort the controller to propagate cancellation downstream.
                abortController.abort();
                reject(
                  new Error(
                    "Public catalog request exceeded the route timeout.",
                  ),
                );
              },
              { once: true },
            );
          });
          const metas = await Promise.race([searchPromise, timeoutPromise]);
          finishLog(metas.length, metas.length === 0 ? "empty" : "success");
          return { metas };
        } catch (error) {
          // A failing metadata backend must never surface as an HTTP error
          // to Stremio's public catalog resource. Convert any backend,
          // timeout, or cancellation failure into a valid empty catalog
          // response while still recording the classification internally.
          const outcome: "metadata_error" | "timeout" | "cancelled" =
            routeTimeout.aborted
              ? "timeout"
              : abortController.signal.aborted
                ? "cancelled"
                : "metadata_error";
          const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
          diagnostics.itemCount = 0;
          request.log.warn(
            {
              requestId: request.id,
              catalogId,
              skip: extra.skip,
              elapsedMs: Date.now() - startedAt,
              resultCount: 0,
              outcome,
              errorName: error instanceof Error ? error.name : "UnknownError",
              ...(deltas === undefined ? {} : deltas),
            },
            "Public catalog search failed",
          );
          return { metas: [] };
        } finally {
          // Remove observers to avoid leaking listeners on the request/
          // response objects after the handler completes.
          request.raw.removeListener("aborted", onRequestAborted);
          reply.raw.removeListener("close", onResponseFinished);
        }
      };

    for (const catalogId of [LEGACY_CATALOG_ID, REPAIRED_CATALOG_ID]) {
      app.get(`/catalog/series/${catalogId}.json`, emptyCatalog);
      app.get<{ Params: { extra: string } }>(
        `/catalog/series/${catalogId}/:extra.json`,
        searchCatalog(catalogId),
      );
    }
    app.get(
      `${REPAIRED_BASE_PATH}/catalog/series/${REPAIRED_CATALOG_ID}.json`,
      emptyCatalog,
    );
    app.get<{ Params: { extra: string } }>(
      `${REPAIRED_BASE_PATH}/catalog/series/${REPAIRED_CATALOG_ID}/:extra.json`,
      searchCatalog(REPAIRED_CATALOG_ID),
    );

    const metaHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = request.params.id;
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "meta";
      diagnostics.virtualIdPrefix = virtualIdPrefix(id);
      const statsBefore = service.metadataStats;
      try {
        const result = await service.publicMeta(id);
        const videos = result.meta.videos;
        diagnostics.itemCount = Array.isArray(videos) ? videos.length : 0;
        const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
        request.log.info(
          {
            requestId: request.id,
            virtualIdPrefix: diagnostics.virtualIdPrefix,
            elapsedMs: Date.now() - diagnostics.startedAt,
            itemCount: diagnostics.itemCount,
            ...(deltas === undefined ? {} : deltas),
          },
          "Public meta request finished",
        );
        return result;
      } catch (error) {
        const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
        request.log.warn(
          {
            requestId: request.id,
            virtualIdPrefix: diagnostics.virtualIdPrefix,
            elapsedMs: Date.now() - diagnostics.startedAt,
            itemCount: 0,
            errorName: error instanceof Error ? error.name : "UnknownError",
            ...(deltas === undefined ? {} : deltas),
          },
          "Public meta request failed",
        );
        return reply
          .code(
            error instanceof InvalidVirtualStremioIdError
              ? 404
              : infrastructureStatus(error),
          )
          .send({ meta: null });
      }
    };
    app.get<{ Params: { id: string } }>("/meta/series/:id.json", metaHandler);
    app.get<{ Params: { id: string } }>(
      `${REPAIRED_BASE_PATH}/meta/series/:id.json`,
      metaHandler,
    );

    const streamHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = request.params.id;
      const diagnostics = requestDiagnostics(request);
      diagnostics.resourceType = "stream";
      diagnostics.virtualIdPrefix = virtualIdPrefix(id);
      const statsBefore = service.metadataStats;
      try {
        const result = await service.publicStream(id);
        diagnostics.itemCount = result.streams.length;
        const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
        request.log.info(
          {
            requestId: request.id,
            virtualIdPrefix: diagnostics.virtualIdPrefix,
            elapsedMs: Date.now() - diagnostics.startedAt,
            itemCount: diagnostics.itemCount,
            ...(deltas === undefined ? {} : deltas),
          },
          "Public stream request finished",
        );
        return result;
      } catch (error) {
        const deltas = metadataStatDeltas(statsBefore, service.metadataStats);
        request.log.warn(
          {
            requestId: request.id,
            virtualIdPrefix: diagnostics.virtualIdPrefix,
            elapsedMs: Date.now() - diagnostics.startedAt,
            itemCount: 0,
            errorName: error instanceof Error ? error.name : "UnknownError",
            ...(deltas === undefined ? {} : deltas),
          },
          "Public stream request failed",
        );
        if (isResolvableStreamFailure(error)) return { streams: [] };
        return reply.code(infrastructureStatus(error)).send({ streams: [] });
      }
    };
    app.get<{ Params: { id: string } }>(
      "/stream/series/:id.json",
      streamHandler,
    );
    app.get<{ Params: { id: string } }>(
      `${REPAIRED_BASE_PATH}/stream/series/:id.json`,
      streamHandler,
    );
  };
}
