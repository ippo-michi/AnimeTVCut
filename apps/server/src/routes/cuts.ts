import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  PreparedSourceError,
  type CutService,
} from "../services/cut-service.js";
import {
  MediaFlowAuthenticationError,
  MediaFlowError,
  MediaFlowUnavailableError,
} from "../services/mediaflow/errors.js";

const episodeIdSchema = z.string().min(1).max(128);
const sourceHeadersSchema = z.record(
  z.string().min(1).max(128),
  z.string().max(8_192),
);

const sourceSchema = z.union([
  z.object({
    episodeId: episodeIdSchema,
    playlistUrl: z.string().min(1),
  }),
  z.object({
    kind: z.literal("fixture_hls"),
    episodeId: episodeIdSchema,
    playlistUrl: z.string().min(1),
  }),
  z.object({
    kind: z.enum(["http_file", "http_media"]),
    episodeId: episodeIdSchema,
    url: z.string().min(1),
    headers: sourceHeadersSchema.optional(),
  }),
]);

const cutRequestSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  remove: z.array(
    z.object({
      episodeId: z.string().min(1).max(128),
      start: z.number().finite().nonnegative(),
      end: z.number().finite().positive(),
      type: z.enum(["opening", "ending", "recap", "preview"]),
    }),
  ),
  alignmentPolicy: z.enum(["preserve_content", "aggressive"]).optional(),
  strictAlignment: z.boolean().optional(),
});

export function cutRoutes(cutService: CutService): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/v1/dev/cuts", async (request, reply) => {
      const parsed = cutRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid cut request",
          details: parsed.error.flatten(),
        });
      }
      try {
        const sources = parsed.data.sources.map((source) => {
          if (!("kind" in source)) {
            return {
              kind: "fixture_hls" as const,
              episodeId: source.episodeId,
              playlistUrl: source.playlistUrl,
            };
          }
          if (source.kind === "http_file") {
            return {
              kind: "http_media" as const,
              episodeId: source.episodeId,
              url: source.url,
              ...(source.headers === undefined
                ? {}
                : { headers: source.headers }),
            };
          }
          if (source.kind === "fixture_hls") return source;
          return {
            kind: "http_media" as const,
            episodeId: source.episodeId,
            url: source.url,
            ...(source.headers === undefined
              ? {}
              : { headers: source.headers }),
          };
        });
        return await cutService.createCut({ ...parsed.data, sources });
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Cut request rejected",
        );
        const rootError =
          error instanceof PreparedSourceError ? error.cause : error;
        const statusCode =
          rootError instanceof MediaFlowUnavailableError
            ? 503
            : rootError instanceof MediaFlowAuthenticationError ||
                rootError instanceof MediaFlowError
              ? 502
              : 400;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "Cut request failed",
        });
      }
    });
  };
}
