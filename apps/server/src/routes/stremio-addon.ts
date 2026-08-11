import type { FastifyPluginAsync } from "fastify";

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

export const ANIMETVCUT_VERSION = "0.1.1";

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
): FastifyPluginAsync {
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
    app.options("/catalog/series/animetvcut.json", optionsHandler);
    app.options("/catalog/series/animetvcut/:extra.json", optionsHandler);
    app.options("/meta/series/:id.json", optionsHandler);
    app.options("/stream/series/:id.json", optionsHandler);

    app.get("/manifest.json", async () => ({
      id: "org.animetvcut.addon",
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
          id: "animetvcut",
          name: "AnimeTVCut",
          extra: [{ name: "search", isRequired: true }],
        },
      ],
      behaviorHints: { configurable: false },
    }));

    app.get("/catalog/series/animetvcut.json", async () => ({ metas: [] }));
    app.get<{ Params: { extra: string } }>(
      "/catalog/series/animetvcut/:extra.json",
      async (request, reply) => {
        try {
          const extra = parseExtra(request.params.extra);
          if (extra.search === undefined || extra.search.trim().length === 0) {
            return { metas: [] };
          }
          // This catalog expands one upstream result into multiple cut modes,
          // so its output-space pagination cannot be forwarded upstream.
          // Legacy/cached clients receive a terminal empty page instead.
          if (!extra.skipValid || extra.skip > 0) return { metas: [] };
          return {
            metas: await service.search(extra.search),
          };
        } catch (error) {
          request.log.info(
            { errorName: error instanceof Error ? error.name : "UnknownError" },
            "Public catalog request rejected",
          );
          return reply.code(infrastructureStatus(error)).send({ metas: [] });
        }
      },
    );

    app.get<{ Params: { id: string } }>(
      "/meta/series/:id.json",
      async (request, reply) => {
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
      },
    );

    app.get<{ Params: { id: string } }>(
      "/stream/series/:id.json",
      async (request, reply) => {
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
      },
    );
  };
}
