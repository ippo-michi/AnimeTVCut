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

function disableClientCaching(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store, max-age=0");
  void reply.header("pragma", "no-cache");
  void reply.header("expires", "0");
}

function addonManifest(id: string, catalogId: string, supportsSkip: boolean) {
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
        extra: [
          { name: "search", isRequired: true },
          ...(supportsSkip ? [{ name: "skip" }] : []),
        ],
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

    app.get("/manifest.json", async (_request, reply) => {
      disableClientCaching(reply);
      return addonManifest(LEGACY_ADDON_ID, LEGACY_CATALOG_ID, false);
    });
    // A separate standards-compatible identity is intentional. Stremio may
    // retain a poisoned catalog registration without issuing another HTTP
    // request; installing this manifest creates a clean client-side record.
    app.get("/manifest-v2.json", async (_request, reply) => {
      disableClientCaching(reply);
      return addonManifest(REPAIRED_ADDON_ID, REPAIRED_CATALOG_ID, true);
    });
    app.get(`${REPAIRED_BASE_PATH}/manifest.json`, async (_request, reply) => {
      disableClientCaching(reply);
      return addonManifest(REPAIRED_ADDON_ID, REPAIRED_CATALOG_ID, true);
    });

    const emptyCatalog = async (
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      disableClientCaching(reply);
      return { metas: [] };
    };
    const searchCatalog = async (
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
      try {
        disableClientCaching(reply);
        const extra = parseExtra(request.params.extra);
        if (extra.search === undefined || extra.search.trim().length === 0) {
          return { metas: [] };
        }
        // `skip` is in this addon's expanded output space. Forwarding it to
        // the metadata addon skips unrelated source shows; slicing the
        // deterministic TV/season/series variants also supports clients
        // which resume catalog pagination after a previous selection.
        if (!extra.skipValid) return { metas: [] };
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
                new Error("Public catalog request exceeded the route timeout."),
              );
            },
            { once: true },
          );
        });
        const metas = await Promise.race([searchPromise, timeoutPromise]);
        return { metas: metas.slice(extra.skip) };
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Public catalog request rejected",
        );
        return reply.code(infrastructureStatus(error)).send({ metas: [] });
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
        searchCatalog,
      );
    }
    app.get(
      `${REPAIRED_BASE_PATH}/catalog/series/${REPAIRED_CATALOG_ID}.json`,
      emptyCatalog,
    );
    app.get<{ Params: { extra: string } }>(
      `${REPAIRED_BASE_PATH}/catalog/series/${REPAIRED_CATALOG_ID}/:extra.json`,
      searchCatalog,
    );

    const metaHandler = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        return await service.publicMeta(request.params.id);
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Public meta request rejected",
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
      try {
        return await service.publicStream(request.params.id);
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Public stream request rejected",
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
