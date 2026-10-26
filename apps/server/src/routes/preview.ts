import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { TvCutCatalogService } from "../services/tv-cut-catalog-service.js";
import { explainCutFailure } from "../services/cut-availability.js";

export function previewRoutes(
  provider: (request: FastifyRequest) => TvCutCatalogService,
): FastifyPluginAsync {
  return async (app) => {
    for (const kind of ["plan", "cut"] as const) {
      app.get<{ Params: { id: string } }>(
        `/api/v1/preview/${kind}/:id`,
        async (request, reply) => {
          void reply.header("cache-control", "no-store");
          if (request.params.id.length > 2048)
            return reply.code(400).send({ error: "Invalid cut ID." });
          const controller = new AbortController();
          const cancel = () => {
            if (!reply.raw.writableEnded) controller.abort();
          };
          request.raw.once("aborted", cancel);
          reply.raw.once("close", cancel);
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(kind === "plan" ? 30_000 : 300_000),
          ]);
          try {
            const service = provider(request);
            return kind === "plan"
              ? await service.previewPlan(request.params.id, signal)
              : await service.previewCut(request.params.id, signal);
          } catch (error) {
            const explanation = explainCutFailure(error);
            return reply
              .code(422)
              .send({ ...explanation, error: explanation.message });
          } finally {
            request.raw.removeListener("aborted", cancel);
            reply.raw.removeListener("close", cancel);
          }
        },
      );
    }
  };
}
