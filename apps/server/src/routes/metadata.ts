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

    app.post("/api/v1/dev/long-cuts/plan", async (request, reply) => {
      const parsed = z
        .object({ sourceSeriesId: z.string().min(1).max(1024) })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid source metadata ID." });
      try {
        return await service.longCutDiagnostics(parsed.data.sourceSeriesId);
      } catch (error) {
        request.log.info(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Long Cut planning rejected",
        );
        return reply.code(client === undefined ? 503 : 502).send({
          error: "Long Cut planning failed.",
        });
      }
    });

    app.get<{ Params: { cutId: string } }>(
      "/api/v1/dev/long-cuts/:cutId",
      async (request, reply) => {
        const session = service.cutSession(request.params.cutId);
        if (session?.longFormDiagnostics === undefined)
          return reply
            .code(404)
            .send({ error: "Long Cut is missing or expired." });
        return reply.send(session.longFormDiagnostics);
      },
    );
  };
}
