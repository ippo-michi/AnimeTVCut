import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { MetadataStremioClient } from "@animetvcut/stremio";

import type { TvCutCatalogService } from "../services/tv-cut-catalog-service.js";

export function metadataRoutes(
  client: MetadataStremioClient | undefined,
  service: TvCutCatalogService,
): FastifyPluginAsync {
  return async (app) => {
    app.get("/api/v1/dev/metadata/health", async () => {
      if (client === undefined) {
        return { configured: false, reachable: false, manifestValid: false };
      }
      return client.checkHealth();
    });

    app.get(
      "/api/v1/dev/tv-cuts/grouping/:sourceId",
      async (request, reply) => {
        const parsed = z
          .object({ sourceId: z.string().min(1).max(1024) })
          .safeParse(request.params);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Invalid source metadata ID." });
        }
        try {
          return await service.planBySourceId(parsed.data.sourceId);
        } catch (error) {
          request.log.info(
            { errorName: error instanceof Error ? error.name : "UnknownError" },
            "Metadata grouping rejected",
          );
          return reply.code(client === undefined ? 503 : 502).send({
            error:
              error instanceof Error
                ? error.message
                : "Metadata grouping failed.",
          });
        }
      },
    );
  };
}
