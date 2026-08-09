import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { CutService } from "../services/cut-service.js";

const cutRequestSchema = z.object({
  sources: z
    .array(
      z.object({
        episodeId: z.string().min(1).max(128),
        playlistUrl: z.string().min(1),
      }),
    )
    .min(1),
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
        return await cutService.createCut(parsed.data);
      } catch (error) {
        request.log.info({ error }, "Cut request rejected");
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Cut request failed",
        });
      }
    });
  };
}
