import type { FastifyPluginAsync } from "fastify";

import type { MediaFlowClient } from "../services/mediaflow/client.js";

export function mediaFlowHealthRoutes(
  client: MediaFlowClient | undefined,
): FastifyPluginAsync {
  return async (app) => {
    app.get("/api/v1/dev/mediaflow/health", async () => {
      if (client === undefined) {
        return { configured: false, reachable: false };
      }
      return {
        configured: true,
        reachable: await client.isReachable(),
        requests: client.stats,
      };
    });
  };
}
