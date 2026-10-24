import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

export function protectDevelopmentApi(
  app: FastifyInstance,
  enabled: boolean,
  token?: string,
): void {
  if (process.env.NODE_ENV === "production" && enabled && !token)
    throw new Error(
      "DEV_API_TOKEN is required when the development API is enabled in production.",
    );
  const expected =
    token === undefined
      ? undefined
      : createHash("sha256").update(`Bearer ${token}`).digest();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/v1/dev/")) return;
    if (!enabled) return reply.code(404).send({ error: "Not found" });
    if (expected !== undefined) {
      const actual = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(actual, expected))
        return reply
          .header("www-authenticate", "Bearer")
          .code(401)
          .send({ error: "Unauthorized" });
    }
  });
}
