import {
  EmbeddedSubtitleService,
  type EmbeddedSubtitleReader,
} from "./services/embedded-subtitles.js";
import { operationalAlerts } from "./services/operational-alerts.js";
import { previewRoutes } from "./routes/preview.js";
import { configurationRoutes } from "./routes/configure.js";
import {
  decodePreferences,
  encodePreferences,
} from "./services/playback-preferences.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  cacheStats,
  cleanupCaches,
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
import { protectDevelopmentApi } from "./services/development-api.js";
import { OperationMetrics } from "./services/operation-metrics.js";
import { CutSessionStore } from "./services/cut-session-store.js";
import { SessionPersistence } from "./services/session-persistence.js";
import { RecoverableSourceLoader } from "./services/recoverable-source-loader.js";
import { FixtureSourceLoader } from "./services/fixture-source.js";
import type { HlsSourceLoader } from "./services/hls-source-loader.js";
import { MediaFlowClient } from "./services/mediaflow/client.js";
import type { MediaFlowConfigInput } from "./services/mediaflow/config.js";
import { MediaFlowSourceLoader } from "./services/mediaflow/source-loader.js";
import { SourceLoaderRouter } from "./services/source-loader-router.js";
import { SkipService } from "./services/skip-service.js";
import {
  SourceChapterService,
  type SourceChapterReader,
} from "./services/source-chapters.js";
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
import {
  AiometadataWatchProgressReporter,
  CutWatchProgressTracker,
  type EpisodeWatchProgressReporter,
} from "./services/watch-progress.js";

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
  aiometadataWatchTracking?: boolean;
  watchProgressReporter?: EpisodeWatchProgressReporter;
  sourceChapterReader?: SourceChapterReader;
  embeddedSubtitleReader?: EmbeddedSubtitleReader;
  chapterProbeConcurrency?: number;
  devApiEnabled?: boolean;
  devApiToken?: string;
  sessionDirectory?: string;
  maxSessions?: number;
  maxSessionMemoryBytes?: number;
  maxStreamBuilds?: number;
  cleanupIntervalMs?: number;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const chapterConcurrency = options.chapterProbeConcurrency ?? 2;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
  if (
    !Number.isSafeInteger(chapterConcurrency) ||
    chapterConcurrency < 1 ||
    chapterConcurrency > 8 ||
    !Number.isSafeInteger(cleanupIntervalMs) ||
    cleanupIntervalMs < 1
  )
    throw new Error(
      "Invalid preparation or cleanup concurrency configuration.",
    );
  const fixtureRoot =
    options.fixtureRoot ??
    path.resolve(
      fileURLToPath(new URL("../../../fixtures/hls", import.meta.url)),
    );
  const app = Fastify({
    logger: options.logger ?? false,
    routerOptions: { maxParamLength: 2048 },
  });
  protectDevelopmentApi(
    app,
    options.devApiEnabled ?? process.env.NODE_ENV !== "production",
    options.devApiToken,
  );
  const metrics = new OperationMetrics((stage, elapsedMs, failed) => {
    app.log.info(
      { stage, elapsedMs, failed },
      "Cut preparation stage finished",
    );
  });
  const fixtureLoader = new FixtureSourceLoader(fixtureRoot);
  const mediaFlowClient =
    options.mediaFlow === undefined
      ? undefined
      : new MediaFlowClient(options.mediaFlow);
  const mediaFlowLoader =
    mediaFlowClient === undefined
      ? undefined
      : new MediaFlowSourceLoader(mediaFlowClient);
  const baseSourceLoader =
    options.sourceLoader ??
    new SourceLoaderRouter(fixtureLoader, mediaFlowLoader);
  const upstreamClient =
    options.upstreamClient ??
    (options.upstreamStremio === undefined
      ? undefined
      : new StremioUpstreamClient(options.upstreamStremio));
  const sourceLoader = new RecoverableSourceLoader(
    baseSourceLoader,
    upstreamClient,
    () => sessions.checkpointAll(),
  );
  const persistence =
    options.sessionDirectory === undefined
      ? undefined
      : new SessionPersistence(options.sessionDirectory, sourceLoader);
  const sessions = new CutSessionStore({
    idleTtlMilliseconds:
      options.sessionTtlMilliseconds ?? options.sessionIdleTtlMilliseconds,
    maxLifetimeMilliseconds:
      options.sessionTtlMilliseconds ?? options.sessionMaxLifetimeMilliseconds,
    now: options.now,
    persistence,
    maxSessions: options.maxSessions,
    maxMemoryBytes: options.maxSessionMemoryBytes,
  });
  app.addHook("preClose", () => Promise.resolve(sourceLoader.close()));
  app.addHook("onClose", () => Promise.resolve(sessions.close()));
  const cutService = new CutService(sourceLoader, sessions);
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
    undefined,
    options.embeddedSubtitleReader ??
      (upstreamClient === undefined
        ? undefined
        : new EmbeddedSubtitleService(subtitleConfig.maxSourceBytes)),
  );
  const sourceChapterReader =
    options.sourceChapterReader ??
    (upstreamClient === undefined
      ? undefined
      : new SourceChapterService(options.chapterProbeConcurrency ?? 2));
  const episodeSourceResolver =
    options.episodeSourceResolver ??
    (upstreamClient === undefined
      ? undefined
      : new StremioEpisodeSourceResolver(upstreamClient, {
          chapterReader: sourceChapterReader,
        }));
  const skipService = new SkipService(
    options.skipSegmentResolver ??
      new SkipSegmentResolver(options.skipProviders ?? []),
  );
  const upstreamCutService = new UpstreamCutService(
    episodeSourceResolver,
    cutService,
    skipService,
    subtitleService,
    sourceChapterReader,
    metrics,
    options.chapterProbeConcurrency ?? 2,
  );
  const metadataClient =
    options.metadataClient ??
    (options.metadataStremio === undefined
      ? undefined
      : new MetadataStremioClient(options.metadataStremio));
  const watchProgressReporter =
    options.watchProgressReporter ??
    (metadataClient !== undefined && options.aiometadataWatchTracking !== false
      ? new AiometadataWatchProgressReporter(metadataClient)
      : undefined);
  const watchProgressTracker =
    watchProgressReporter === undefined
      ? undefined
      : new CutWatchProgressTracker(watchProgressReporter, (id) =>
          sessions.checkpoint(id),
        );
  const tvCutCatalogService = new TvCutCatalogService(
    metadataClient,
    upstreamCutService,
    cutService,
    options.publicBaseUrl,
    options.groupingConfig ?? DEFAULT_TV_CUT_GROUPING_CONFIG,
    options.now,
    options.streamCacheTtlMs,
    options.longCuts ?? DEFAULT_LONG_CUT_CONFIGURATION,
    options.maxStreamBuilds,
    {},
    metrics,
    () => activeBuilds() < (options.maxStreamBuilds ?? 8),
  );
  app.addHook("preClose", () => Promise.resolve(tvCutCatalogService.close()));
  const profileServices = new Map<string, TvCutCatalogService>();
  const activeBuilds = (): number =>
    tvCutCatalogService.activeBuilds +
    [...profileServices.values()].reduce(
      (total, service) => total + service.activeBuilds,
      0,
    );
  const profileService = (profile: string): TvCutCatalogService => {
    const preferences = decodePreferences(profile);
    const key = encodePreferences(preferences);
    const existing = profileServices.get(key);
    if (existing !== undefined) {
      profileServices.delete(key);
      profileServices.set(key, existing);
      return existing;
    }
    if (profileServices.size >= 32) {
      const idle = [...profileServices].find(
        ([, service]) => service.activeBuilds === 0,
      );
      if (idle === undefined)
        throw new Error("Profile capacity is exhausted. Retry shortly.");
      idle[1].close();
      profileServices.delete(idle[0]);
    }
    const grouping = options.groupingConfig ?? DEFAULT_TV_CUT_GROUPING_CONFIG;
    if ((preferences.episodesPerGroup ?? 1) > grouping.maximumEpisodes)
      throw new Error("Group size exceeds the configured server limit.");
    const service = new TvCutCatalogService(
      metadataClient,
      upstreamCutService,
      cutService,
      options.publicBaseUrl,
      {
        ...grouping,
        ...(preferences.episodesPerGroup === undefined
          ? {}
          : { episodesPerGroup: preferences.episodesPerGroup }),
      },
      options.now,
      options.streamCacheTtlMs,
      options.longCuts ?? DEFAULT_LONG_CUT_CONFIGURATION,
      options.maxStreamBuilds,
      preferences,
      metrics,
      () => activeBuilds() < (options.maxStreamBuilds ?? 8),
    );
    profileServices.set(key, service);
    return service;
  };
  app.addHook("preClose", () => {
    for (const service of profileServices.values()) service.close();
    return Promise.resolve();
  });
  const checkConnections = async () => {
    const states = await Promise.all([
      metadataClient
        ?.checkHealth()
        .then((r) => r.reachable && r.manifestValid)
        .catch(() => false) ?? false,
      upstreamClient
        ?.checkHealth()
        .then((r) => r.reachable && r.manifestValid)
        .catch(() => false) ?? false,
      mediaFlowClient?.isReachable().catch(() => false) ?? false,
    ]);
    const dependencies = Object.fromEntries(
      ["metadata", "upstream", "mediaflow"].map((name, i) => [
        name,
        {
          configured:
            [metadataClient, upstreamClient, mediaFlowClient][i] !== undefined,
          ready: states[i],
        },
      ]),
    );
    return { ready: states.every(Boolean), dependencies };
  };
  let connectionCheck: ReturnType<typeof checkConnections> | undefined;
  let connectionCheckExpires = 0;
  const connections = () => {
    if (connectionCheck === undefined || Date.now() >= connectionCheckExpires) {
      connectionCheckExpires = Date.now() + 30_000;
      connectionCheck = checkConnections();
    }
    return connectionCheck;
  };
  void app.register(
    configurationRoutes({
      publicBaseUrl: options.publicBaseUrl,
      defaults: {
        episodesPerGroup: (
          options.groupingConfig ?? DEFAULT_TV_CUT_GROUPING_CONFIG
        ).episodesPerGroup,
        maximumEpisodes: (
          options.groupingConfig ?? DEFAULT_TV_CUT_GROUPING_CONFIG
        ).maximumEpisodes,
      },
      connections,
    }),
  );
  void app.register(
    async (profileApp) => {
      profileApp.addHook("onRequest", async (request, reply) => {
        try {
          profileService((request.params as { profile: string }).profile);
        } catch {
          return reply
            .code(400)
            .send({ error: "Invalid or unavailable playback profile." });
        }
      });
      await profileApp.register(
        previewRoutes((request) =>
          profileService((request.params as { profile: string }).profile),
        ),
      );
      await profileApp.register(
        publicStremioRoutes((request) =>
          profileService((request.params as { profile: string }).profile),
        ),
      );
    },
    { prefix: "/p/:profile" },
  );

  const alerts = () =>
    operationalAlerts(
      sessions.stats(),
      metrics.snapshot(),
      activeBuilds(),
      options.maxStreamBuilds ?? 8,
    );
  let previousAlerts = new Set<string>();
  const cleanup = setInterval(() => {
    sessions.cleanup();
    cleanupCaches();
    const current = alerts();
    for (const alert of current)
      if (!previousAlerts.has(alert.code))
        app.log.warn(alert, "Operational alert");
    previousAlerts = new Set(current.map((alert) => alert.code));
  }, cleanupIntervalMs);
  cleanup.unref();
  app.addHook("preClose", () => Promise.resolve(clearInterval(cleanup)));
  app.get("/api/v1/dev/diagnostics", () =>
    Promise.resolve({
      memory: process.memoryUsage(),
      sessions: sessions.stats(),
      caches: cacheStats(),
      activeBuilds: activeBuilds(),
      preparation: metrics.snapshot(),
    }),
  );

  app.get("/api/v1/dev/readiness", async (_request, reply) => {
    const result = await connections();
    return reply
      .code(result.ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send(result);
  });
  app.get("/api/v1/dev/alerts", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ alerts: alerts() }),
  );
  void app.register(healthRoutes);
  void app.register(mediaFlowHealthRoutes(mediaFlowClient));
  void app.register(upstreamHealthRoutes(upstreamClient));
  void app.register(skipRoutes(skipService));
  void app.register(cutRoutes(cutService));
  void app.register(upstreamRoutes(upstreamCutService));
  void app.register(metadataRoutes(metadataClient, tvCutCatalogService));
  void app.register(publicStremioRoutes(tvCutCatalogService));
  void app.register(previewRoutes(() => tvCutCatalogService));
  void app.register(
    mediaRoutes(
      sessions,
      subtitleService,
      options.mediaPrefetchResources ?? 0,
      watchProgressTracker,
      metrics,
    ),
  );

  return app;
}
