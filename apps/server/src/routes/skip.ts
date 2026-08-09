import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  sanitizeSkipResolution,
  type SkipService,
} from "../services/skip-service.js";

const episodeSchema = z.object({
  episodeId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  videoId: z.string().min(1).max(512),
  durationSeconds: z.number().finite().positive(),
  skipIdentity: z
    .object({
      malAnimeId: z.number().int().positive(),
      malEpisode: z.number().int().positive(),
    })
    .optional(),
});

const resolveSchema = z.object({
  episodes: z.array(episodeSchema).min(1).max(32),
});

export function skipRoutes(service: SkipService): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/v1/dev/skip/resolve", async (request, reply) => {
      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid skip resolution request",
          details: parsed.error.flatten(),
        });
      }
      const resolutions = await service.resolve(
        parsed.data.episodes.map(({ durationSeconds, ...reference }) => ({
          reference,
          durationSeconds,
        })),
      );
      return {
        episodes: resolutions.map(sanitizeSkipResolution),
      };
    });

    app.get("/api/v1/dev/skip/health", async () => ({
      providers: await service.health(),
    }));
  };
}
