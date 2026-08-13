import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  DEFAULT_TV_CUT_GROUPING_CONFIG,
  type TvCutGroupingConfig,
} from "@animetvcut/core";
import {
  MetadataStremioClient,
  type MetadataStremioConfigInput,
} from "@animetvcut/stremio";
import {
  SkipSegmentResolver,
  type SkipSegmentProvider,
} from "@animetvcut/skip-providers";

import { cutRoutes } from "./routes/cuts.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { mediaFlowHealthRoutes } from "./routes/mediaflow-health.js";
import { metadataRoutes } from "./routes/metadata.js";
import { skipRoutes } from "./routes/skip.js";
import { upstreamHealthRoutes } from "./routes/upstream-health.js";
import { upstreamRoutes } from "./routes/upstream.js";
import { publicStremioRoutes } from "./routes/stremio-addon.js";
import { CutService } from "./services/cut-service.js";
import { CutSessionStore } from "./services/cut-session-store.js";
import { FixtureSourceLoader } from "./services/fixture-source.js";
import type { HlsSourceLoader } from "./services/hls-source-loader.js";
import { MediaFlowClient } from "./services/mediaflow/client.js";
import type { MediaFlowConfigInput } from "./services/mediaflow/config.js";
import { MediaFlowSourceLoader } from "./services/mediaflow/source-loader.js";
import { SourceLoaderRouter } from "./services/source-loader-router.js";
import { SkipService } from "./services/skip-service.js";
import type { LongCutConfiguration } from "./services/metadata-config.js";
import { DEFAULT_LONG_CUT_CONFIGURATION } from "./services/metadata-config.js";
import { StremioUpstreamClient } from "./services/stremio-upstream/client.js";
import type { StremioUpstreamConfigInput } from "./services/stremio-upstream/config.js";
import { StremioEpisodeSourceResolver } from "./services/stremio-upstream/resolver.js";
import type { EpisodeSourceResolver } from "./services/stremio-upstream/types.js";
import { UpstreamCutService } from "./services/upstream-cut-service.js";
import { TvCutCatalogService } from "./services/tv-cut-catalog-service.js";
import {
  createSubtitleConfig,
  type SubtitleConfigInput,
} from "./services/subtitle-config.js";
import { SubtitleService } from "./services/subtitle-service.js";

export interface AppOptions {
  fixtureRoot?: string;
  sessionTtlMilliseconds?: number;
  sessionIdleTtlMilliseconds?: number;
  sessionMaxLifetimeMilliseconds?: number;
  logger?: FastifyServerOptions["logger"];
  mediaFlow?: MediaFlowConfigInput;
  sourceLoader?: HlsSourceLoader;
  upstreamStremio?: StremioUpstreamConfigInput;
  upstreamClient?: StremioUpstreamClient;
  episodeSourceResolver?: EpisodeSourceResolver;
  skipProviders?: readonly SkipSegmentProvider[];
  skipSegmentResolver?: SkipSegmentResolver;
  metadataStremio?: MetadataStremioConfigInput;
  metadataClient?: MetadataStremioClient;
  publicBaseUrl?: URL;
  groupingConfig?: TvCutGroupingConfig;
  longCuts?: LongCutConfiguration;
  now?: () => number;
  streamCacheTtlMs?: number;
  subtitles?: SubtitleConfigInput;
  mediaPrefetchResources?: number;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const fixtureRoot =
    options.fixtureRoot ??
    path.resolve(
      fileURLToPath(new URL("../../../fixtures/hls", import.meta.url)),
    );
  const app = Fastify({ logger: options.logger ?? false });
  const sessions = new CutSessionStore(
    options.sessionTtlMilliseconds ?? {
      idleTtlMilliseconds: options.sessionIdleTtlMilliseconds,
      maxLifetimeMilliseconds: options.sessionMaxLifetimeMilliseconds,
      now: options.now,
    },
  );
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
  const subtitleInput = options.subtitles ?? {};
  const subtitleConfig = createSubtitleConfig({
    ...subtitleInput,
    allowedOrigins: [
      ...(subtitleInput.allowedOrigins ?? []),
      ...(upstreamClient === undefined
        ? []
        : [upstreamClient.config.manifestUrl.origin]),
    ],
  });
  const subtitleService = new SubtitleService(
    subtitleConfig,
    sessions,
    upstreamClient,
  );
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
    subtitleService,
  );
  const metadataClient =
    options.metadataClient ??
    (options.metadataStremio === undefined
      ? undefined
      : new MetadataStremioClient(options.metadataStremio));
  const tvCutCatalogService = new TvCutCatalogService(
    metadataClient,
    upstreamCutService,
    cutService,
    options.publicBaseUrl,
    options.groupingConfig ?? DEFAULT_TV_CUT_GROUPING_CONFIG,
    options.now,
    options.streamCacheTtlMs,
    options.longCuts ?? DEFAULT_LONG_CUT_CONFIGURATION,
  );

  void app.register(healthRoutes);
  void app.register(mediaFlowHealthRoutes(mediaFlowClient));
  void app.register(upstreamHealthRoutes(upstreamClient));
  void app.register(skipRoutes(skipService));
  void app.register(cutRoutes(cutService));
  void app.register(upstreamRoutes(upstreamCutService));
  void app.register(metadataRoutes(metadataClient, tvCutCatalogService));
  void app.register(publicStremioRoutes(tvCutCatalogService));
  void app.register(
    mediaRoutes(sessions, subtitleService, options.mediaPrefetchResources ?? 0),
  );

  return app;
}
