import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";

import { cutRoutes } from "./routes/cuts.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { CutService } from "./services/cut-service.js";
import { CutSessionStore } from "./services/cut-session-store.js";
import { FixtureSourceLoader } from "./services/fixture-source.js";

export interface AppOptions {
  fixtureRoot?: string;
  sessionTtlMilliseconds?: number;
  logger?: boolean;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const fixtureRoot =
    options.fixtureRoot ??
    path.resolve(fileURLToPath(new URL("../../../fixtures/hls", import.meta.url)));
  const app = Fastify({ logger: options.logger ?? false });
  const sessions = new CutSessionStore(options.sessionTtlMilliseconds);
  const fixtureLoader = new FixtureSourceLoader(fixtureRoot);
  const cutService = new CutService(fixtureLoader, sessions);

  void app.register(healthRoutes);
  void app.register(cutRoutes(cutService));
  void app.register(mediaRoutes(sessions));

  return app;
}
