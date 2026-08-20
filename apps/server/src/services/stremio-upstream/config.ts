import { StremioUpstreamConfigurationError } from "./errors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MANIFEST_CACHE_TTL_MS = 5 * 60_000;
// A season resolver can take roughly a minute at the provider-safe request
// bound. Keep usable candidate families available for the targeted MediaFlow
// retry instead of expiring them halfway through the first preparation pass.
const DEFAULT_STREAM_CACHE_TTL_MS = 5 * 60_000;

export interface StremioUpstreamConfigInput {
  manifestUrl: string | URL;
  requestTimeoutMs?: number;
  manifestCacheTtlMs?: number;
  streamCacheTtlMs?: number;
}

export interface StremioUpstreamConfig {
  manifestUrl: URL;
  requestTimeoutMs: number;
  manifestCacheTtlMs: number;
  streamCacheTtlMs: number;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StremioUpstreamConfigurationError(
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function createStremioUpstreamConfig(
  input: StremioUpstreamConfigInput,
): StremioUpstreamConfig {
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(input.manifestUrl.toString());
  } catch {
    throw new StremioUpstreamConfigurationError(
      "UPSTREAM_STREMIO_MANIFEST_URL is invalid.",
    );
  }
  if (manifestUrl.protocol !== "http:" && manifestUrl.protocol !== "https:") {
    throw new StremioUpstreamConfigurationError(
      "UPSTREAM_STREMIO_MANIFEST_URL must use HTTP or HTTPS.",
    );
  }
  if (!manifestUrl.pathname.endsWith("/manifest.json")) {
    throw new StremioUpstreamConfigurationError(
      "UPSTREAM_STREMIO_MANIFEST_URL must end with manifest.json.",
    );
  }
  if (manifestUrl.hash !== "") {
    throw new StremioUpstreamConfigurationError(
      "UPSTREAM_STREMIO_MANIFEST_URL must not contain a fragment.",
    );
  }

  return {
    manifestUrl,
    requestTimeoutMs: boundedInteger(
      input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "UPSTREAM_STREMIO_REQUEST_TIMEOUT_MS",
      1,
      300_000,
    ),
    manifestCacheTtlMs: boundedInteger(
      input.manifestCacheTtlMs ?? DEFAULT_MANIFEST_CACHE_TTL_MS,
      "manifestCacheTtlMs",
      0,
      3_600_000,
    ),
    streamCacheTtlMs: boundedInteger(
      input.streamCacheTtlMs ?? DEFAULT_STREAM_CACHE_TTL_MS,
      "streamCacheTtlMs",
      0,
      300_000,
    ),
  };
}

export function stremioUpstreamConfigFromEnv(
  environment: NodeJS.ProcessEnv,
): StremioUpstreamConfigInput | undefined {
  const manifestUrl = environment.UPSTREAM_STREMIO_MANIFEST_URL;
  if (manifestUrl === undefined || manifestUrl.trim() === "") return undefined;
  const timeout = environment.UPSTREAM_STREMIO_REQUEST_TIMEOUT_MS;
  return {
    manifestUrl,
    ...(timeout === undefined ? {} : { requestTimeoutMs: Number(timeout) }),
  };
}
