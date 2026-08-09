import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { UpstreamCutService } from "../services/upstream-cut-service.js";
import {
  MediaFlowAuthenticationError,
  MediaFlowError,
  MediaFlowUnavailableError,
} from "../services/mediaflow/errors.js";
import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
  StremioManifestCompatibilityError,
  StremioManifestInvalidError,
  StremioStreamResponseInvalidError,
  StremioUpstreamError,
  StremioUpstreamNotConfiguredError,
  StremioUpstreamUnavailableError,
} from "../services/stremio-upstream/errors.js";

const episodeSchema = z.object({
  episodeId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  videoId: z.string().min(1).max(512),
});

const removeSchema = z.object({
  episodeId: z.string().min(1).max(128),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  type: z.enum(["opening", "ending", "recap", "preview"]),
});

const resolveSchema = z.object({
  episodes: z.array(episodeSchema).min(1).max(32),
  allowMixedSources: z.boolean().optional(),
});

const upstreamCutSchema = resolveSchema.extend({
  remove: z.array(removeSchema),
  alignmentPolicy: z.enum(["preserve_content", "aggressive"]).optional(),
  strictAlignment: z.boolean().optional(),
});

function statusFor(error: unknown): number {
  if (error instanceof StremioUpstreamNotConfiguredError) return 503;
  if (error instanceof StremioUpstreamUnavailableError) return 503;
  if (error instanceof MediaFlowUnavailableError) return 503;
  if (error instanceof MediaFlowAuthenticationError) return 502;
  if (error instanceof MediaFlowError) return 502;
  if (
    error instanceof StremioManifestInvalidError ||
    error instanceof StremioManifestCompatibilityError ||
    error instanceof StremioStreamResponseInvalidError
  ) {
    return 502;
  }
  if (
    error instanceof NoUsableStreamsError ||
    error instanceof NoConsistentStreamFamilyError
  ) {
    return 422;
  }
  return error instanceof StremioUpstreamError ? 400 : 400;
}

function safeErrorBody(error: unknown) {
  const diagnostics =
    error instanceof NoUsableStreamsError
      ? [error.diagnostics]
      : error instanceof NoConsistentStreamFamilyError
        ? error.diagnostics
        : undefined;
  return {
    error: error instanceof Error ? error.message : "Upstream request failed",
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

export function upstreamRoutes(
  service: UpstreamCutService,
): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/v1/dev/upstream/resolve", async (request, reply) => {
      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid upstream resolution request",
          details: parsed.error.flatten(),
        });
      }
      try {
        return await service.resolveEpisodes(
          parsed.data.episodes,
          parsed.data.allowMixedSources ?? false,
        );
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Upstream resolution rejected",
        );
        return reply.code(statusFor(error)).send(safeErrorBody(error));
      }
    });

    app.post("/api/v1/dev/cuts/from-upstream", async (request, reply) => {
      const parsed = upstreamCutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid upstream cut request",
          details: parsed.error.flatten(),
        });
      }
      try {
        return await service.createCutFromEpisodes(parsed.data);
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Upstream cut rejected",
        );
        return reply.code(statusFor(error)).send(safeErrorBody(error));
      }
    });
  };
}
