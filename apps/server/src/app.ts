import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  SkipSegmentResolver,
  type SkipSegmentProvider,
} from "@animetvcut/skip-providers";

import { cutRoutes } from "./routes/cuts.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { mediaFlowHealthRoutes } from "./routes/mediaflow-health.js";
import { skipRoutes } from "./routes/skip.js";
import { upstreamHealthRoutes } from "./routes/upstream-health.js";
import { upstreamRoutes } from "./routes/upstream.js";
import { CutService } from "./services/cut-service.js";
import { CutSessionStore } from "./services/cut-session-store.js";
import { FixtureSourceLoader } from "./services/fixture-source.js";
import type { HlsSourceLoader } from "./services/hls-source-loader.js";
import { MediaFlowClient } from "./services/mediaflow/client.js";
import type { MediaFlowConfigInput } from "./services/mediaflow/config.js";
import { MediaFlowSourceLoader } from "./services/mediaflow/source-loader.js";
import { SourceLoaderRouter } from "./services/source-loader-router.js";
import { SkipService } from "./services/skip-service.js";
import { StremioUpstreamClient } from "./services/stremio-upstream/client.js";
import type { StremioUpstreamConfigInput } from "./services/stremio-upstream/config.js";
import { StremioEpisodeSourceResolver } from "./services/stremio-upstream/resolver.js";
import type { EpisodeSourceResolver } from "./services/stremio-upstream/types.js";
import { UpstreamCutService } from "./services/upstream-cut-service.js";

export interface AppOptions {
  fixtureRoot?: string;
  sessionTtlMilliseconds?: number;
  logger?: FastifyServerOptions["logger"];
  mediaFlow?: MediaFlowConfigInput;
  sourceLoader?: HlsSourceLoader;
  upstreamStremio?: StremioUpstreamConfigInput;
  upstreamClient?: StremioUpstreamClient;
  episodeSourceResolver?: EpisodeSourceResolver;
  skipProviders?: readonly SkipSegmentProvider[];
  skipSegmentResolver?: SkipSegmentResolver;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const fixtureRoot =
    options.fixtureRoot ??
    path.resolve(
      fileURLToPath(new URL("../../../fixtures/hls", import.meta.url)),
    );
  const app = Fastify({ logger: options.logger ?? false });
  const sessions = new CutSessionStore(options.sessionTtlMilliseconds);
  const fixtureLoader = new FixtureSourceLoader(fixtureRoot);
  const mediaFlowClient =
    options.mediaFlow === undefined
      ? undefined
      : new MediaFlowClient(options.mediaFlow);
  const mediaFlowLoader =
    mediaFlowClient === undefined
      ? undefined
      : new MediaFlowSourceLoader(mediaFlowClient);
  const sourceLoader =
    options.sourceLoader ??
    new SourceLoaderRouter(fixtureLoader, mediaFlowLoader);
  const cutService = new CutService(sourceLoader, sessions);
  const upstreamClient =
    options.upstreamClient ??
    (options.upstreamStremio === undefined
      ? undefined
      : new StremioUpstreamClient(options.upstreamStremio));
  const episodeSourceResolver =
    options.episodeSourceResolver ??
    (upstreamClient === undefined
      ? undefined
      : new StremioEpisodeSourceResolver(upstreamClient));
  const skipService = new SkipService(
    options.skipSegmentResolver ??
      new SkipSegmentResolver(options.skipProviders ?? []),
  );
  const upstreamCutService = new UpstreamCutService(
    episodeSourceResolver,
    cutService,
    skipService,
  );

  void app.register(healthRoutes);
  void app.register(mediaFlowHealthRoutes(mediaFlowClient));
  void app.register(upstreamHealthRoutes(upstreamClient));
  void app.register(skipRoutes(skipService));
  void app.register(cutRoutes(cutService));
  void app.register(upstreamRoutes(upstreamCutService));
  void app.register(mediaRoutes(sessions));

  return app;
}
