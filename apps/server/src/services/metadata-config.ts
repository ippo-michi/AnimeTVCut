import {
  DEFAULT_TV_CUT_GROUPING_CONFIG,
  type TvCutGroupingConfig,
} from "@animetvcut/core";
import type { MetadataStremioConfigInput } from "@animetvcut/stremio";

export interface MetadataConfiguration {
  stremio?: MetadataStremioConfigInput;
  publicBaseUrl?: URL;
  grouping: TvCutGroupingConfig;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function normalizePublicBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  url.pathname = "/";
  return url;
}

export function metadataConfigurationFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MetadataConfiguration {
  const manifestUrl = env.METADATA_STREMIO_MANIFEST_URL?.trim();
  const publicBase = env.PUBLIC_BASE_URL?.trim();
  const searchCatalogId = env.METADATA_STREMIO_SEARCH_CATALOG_ID?.trim();
  return {
    ...(manifestUrl === undefined || manifestUrl.length === 0
      ? {}
      : {
          stremio: {
            manifestUrl,
            ...(searchCatalogId === undefined || searchCatalogId.length === 0
              ? {}
              : { searchCatalogId }),
            requestTimeoutMs: parsePositiveInteger(
              env.METADATA_STREMIO_REQUEST_TIMEOUT_MS,
              10_000,
              "METADATA_STREMIO_REQUEST_TIMEOUT_MS",
            ),
          },
        }),
    ...(publicBase === undefined || publicBase.length === 0
      ? {}
      : { publicBaseUrl: normalizePublicBaseUrl(publicBase) }),
    grouping: {
      targetSeconds: parsePositiveInteger(
        env.TV_CUT_TARGET_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.targetSeconds,
        "TV_CUT_TARGET_SECONDS",
      ),
      minimumSeconds: parsePositiveInteger(
        env.TV_CUT_MIN_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.minimumSeconds,
        "TV_CUT_MIN_SECONDS",
      ),
      maximumSeconds: parsePositiveInteger(
        env.TV_CUT_MAX_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.maximumSeconds,
        "TV_CUT_MAX_SECONDS",
      ),
      maximumEpisodes: parsePositiveInteger(
        env.TV_CUT_MAX_EPISODES,
        DEFAULT_TV_CUT_GROUPING_CONFIG.maximumEpisodes,
        "TV_CUT_MAX_EPISODES",
      ),
      assumedOpeningSeconds: parsePositiveInteger(
        env.TV_CUT_ASSUMED_OPENING_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.assumedOpeningSeconds,
        "TV_CUT_ASSUMED_OPENING_SECONDS",
      ),
      assumedEndingSeconds: parsePositiveInteger(
        env.TV_CUT_ASSUMED_ENDING_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.assumedEndingSeconds,
        "TV_CUT_ASSUMED_ENDING_SECONDS",
      ),
      trailingGraceMilliseconds:
        parsePositiveInteger(
          env.TV_CUT_TRAILING_GRACE_DAYS,
          14,
          "TV_CUT_TRAILING_GRACE_DAYS",
        ) *
        24 *
        60 *
        60 *
        1000,
      fallbackRuntimeSeconds: parsePositiveInteger(
        env.TV_CUT_FALLBACK_RUNTIME_SECONDS,
        DEFAULT_TV_CUT_GROUPING_CONFIG.fallbackRuntimeSeconds,
        "TV_CUT_FALLBACK_RUNTIME_SECONDS",
      ),
    },
  };
}
