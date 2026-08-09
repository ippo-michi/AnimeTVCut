import { createApp } from "./app.js";
import { mediaFlowConfigFromEnv } from "./services/mediaflow/config.js";
import { skipProvidersFromEnv } from "./services/skip-config.js";
import { stremioUpstreamConfigFromEnv } from "./services/stremio-upstream/config.js";

const app = createApp({
  logger: true,
  mediaFlow: mediaFlowConfigFromEnv(process.env),
  upstreamStremio: stremioUpstreamConfigFromEnv(process.env),
  skipProviders: skipProvidersFromEnv(process.env),
});
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
