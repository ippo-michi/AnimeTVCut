import { createApp } from "./app.js";
import { mediaFlowConfigFromEnv } from "./services/mediaflow/config.js";
import { metadataConfigurationFromEnv } from "./services/metadata-config.js";
import { skipProvidersFromEnv } from "./services/skip-config.js";
import { stremioUpstreamConfigFromEnv } from "./services/stremio-upstream/config.js";
import { subtitleConfigFromEnv } from "./services/subtitle-config.js";

const metadata = metadataConfigurationFromEnv(process.env);
const app = createApp({
  logger: true,
  devApiEnabled:
    process.env.DEV_API_ENABLED === undefined
      ? process.env.NODE_ENV !== "production"
      : process.env.DEV_API_ENABLED === "true",
  devApiToken: process.env.DEV_API_TOKEN || undefined,
  sessionDirectory: process.env.CUT_SESSION_DIRECTORY || undefined,
  maxSessions: Number(process.env.CUT_SESSION_MAX_COUNT ?? "128"),
  maxSessionMemoryBytes: Number(
    process.env.CUT_SESSION_MAX_MEMORY_BYTES ?? "268435456",
  ),
  maxStreamBuilds: Number(process.env.CUT_MAX_CONCURRENT_BUILDS ?? "8"),
  chapterProbeConcurrency: Number(
    process.env.SOURCE_CHAPTER_PROBE_CONCURRENCY ?? "2",
  ),
  mediaFlow: mediaFlowConfigFromEnv(process.env),
  upstreamStremio: stremioUpstreamConfigFromEnv(process.env),
  skipProviders: skipProvidersFromEnv(process.env),
  metadataStremio: metadata.stremio,
  publicBaseUrl: metadata.publicBaseUrl,
  groupingConfig: metadata.grouping,
  longCuts: metadata.longCuts,
  aiometadataWatchTracking: metadata.aiometadataWatchTracking,
  sessionIdleTtlMilliseconds:
    Number(process.env.CUT_SESSION_IDLE_TTL_SECONDS ?? "21600") * 1000,
  sessionMaxLifetimeMilliseconds:
    Number(process.env.CUT_SESSION_MAX_LIFETIME_SECONDS ?? "172800") * 1000,
  subtitles: subtitleConfigFromEnv(process.env),
  mediaPrefetchResources: Number.parseInt(
    process.env.MEDIA_PREFETCH_RESOURCES ?? "3",
    10,
  ),
});
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
  const shutdown = () => {
    app.log.info("Closing AnimeTVCut");
    void app.close().catch((error: unknown) => {
      app.log.error({ err: error }, "AnimeTVCut shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
