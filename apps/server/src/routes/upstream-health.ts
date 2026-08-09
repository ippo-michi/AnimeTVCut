import type { FastifyPluginAsync } from "fastify";

import type { StremioUpstreamClient } from "../services/stremio-upstream/client.js";

export function upstreamHealthRoutes(
  client: StremioUpstreamClient | undefined,
): FastifyPluginAsync {
  return async (app) => {
    app.get("/api/v1/dev/upstream/health", async () => {
      if (client === undefined) {
        return { configured: false, reachable: false, manifestValid: false };
      }
      return { ...(await client.checkHealth()), requests: client.stats };
    });
  };
}
