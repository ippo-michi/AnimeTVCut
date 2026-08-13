import {
  DEFAULT_LONG_CUT_PLANNING_CONFIG,
  DEFAULT_TV_CUT_GROUPING_CONFIG,
  type LongCutPlanningConfig,
  type TvCutGroupingConfig,
} from "@animetvcut/core";
import type { MetadataStremioConfigInput } from "@animetvcut/stremio";

export interface MetadataConfiguration {
  stremio?: MetadataStremioConfigInput;
  publicBaseUrl?: URL;
  grouping: TvCutGroupingConfig;
  longCuts: LongCutConfiguration;
}

export interface LongCutConfiguration {
  exposeTv: boolean;
  exposeSeason: boolean;
  exposeSeries: boolean;
  planning: LongCutPlanningConfig;
  maxMediaSegments: number;
  maxManifestBytes: number;
  seasonPrepareConcurrency: number;
}

export const DEFAULT_LONG_CUT_CONFIGURATION: LongCutConfiguration = {
  exposeTv: true,
  exposeSeason: true,
  exposeSeries: true,
  planning: DEFAULT_LONG_CUT_PLANNING_CONFIG,
  maxMediaSegments: 20_000,
  maxManifestBytes: 5_242_880,
  seasonPrepareConcurrency: 2,
};

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

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`${name} must be true or false.`);
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
      episodesPerGroup: parsePositiveInteger(
        env.TV_CUT_EPISODES_PER_GROUP,
        DEFAULT_TV_CUT_GROUPING_CONFIG.episodesPerGroup,
        "TV_CUT_EPISODES_PER_GROUP",
      ),
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
    longCuts: {
      exposeTv: parseBoolean(env.EXPOSE_TV_CUT, true, "EXPOSE_TV_CUT"),
      exposeSeason: parseBoolean(
        env.EXPOSE_SEASON_CUT,
        true,
        "EXPOSE_SEASON_CUT",
      ),
      exposeSeries: parseBoolean(
        env.EXPOSE_SERIES_CUT,
        true,
        "EXPOSE_SERIES_CUT",
      ),
      planning: {
        finalizeAfterMilliseconds:
          parsePositiveInteger(
            env.LONG_CUT_FINALIZE_AFTER_DAYS,
            14,
            "LONG_CUT_FINALIZE_AFTER_DAYS",
          ) *
          24 *
          60 *
          60 *
          1000,
        allowUnknownReleaseDates: parseBoolean(
          env.LONG_CUT_ALLOW_UNKNOWN_RELEASE_DATES,
          false,
          "LONG_CUT_ALLOW_UNKNOWN_RELEASE_DATES",
        ),
        seasonMaxEpisodes: parsePositiveInteger(
          env.SEASON_CUT_MAX_EPISODES,
          30,
          "SEASON_CUT_MAX_EPISODES",
        ),
        seriesMaxEpisodes: parsePositiveInteger(
          env.SERIES_CUT_MAX_EPISODES,
          60,
          "SERIES_CUT_MAX_EPISODES",
        ),
        seasonMaxEstimatedSeconds: parsePositiveInteger(
          env.SEASON_CUT_MAX_ESTIMATED_SECONDS,
          43_200,
          "SEASON_CUT_MAX_ESTIMATED_SECONDS",
        ),
        seriesMaxEstimatedSeconds: parsePositiveInteger(
          env.SERIES_CUT_MAX_ESTIMATED_SECONDS,
          86_400,
          "SERIES_CUT_MAX_ESTIMATED_SECONDS",
        ),
        includeSeasonZeroInSeries: parseBoolean(
          env.SERIES_CUT_INCLUDE_SEASON_ZERO,
          false,
          "SERIES_CUT_INCLUDE_SEASON_ZERO",
        ),
      },
      maxMediaSegments: parsePositiveInteger(
        env.LONG_CUT_MAX_MEDIA_SEGMENTS,
        20_000,
        "LONG_CUT_MAX_MEDIA_SEGMENTS",
      ),
      maxManifestBytes: parsePositiveInteger(
        env.LONG_CUT_MAX_MANIFEST_BYTES,
        5_242_880,
        "LONG_CUT_MAX_MANIFEST_BYTES",
      ),
      seasonPrepareConcurrency: parsePositiveInteger(
        env.LONG_CUT_SEASON_PREPARE_CONCURRENCY,
        2,
        "LONG_CUT_SEASON_PREPARE_CONCURRENCY",
      ),
    },
  };
}
