import { createApp } from "./app.js";
import { mediaFlowConfigFromEnv } from "./services/mediaflow/config.js";
import { metadataConfigurationFromEnv } from "./services/metadata-config.js";
import { skipProvidersFromEnv } from "./services/skip-config.js";
import { stremioUpstreamConfigFromEnv } from "./services/stremio-upstream/config.js";
import { subtitleConfigFromEnv } from "./services/subtitle-config.js";

const metadata = metadataConfigurationFromEnv(process.env);
const app = createApp({
  logger: true,
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
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
