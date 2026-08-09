export type LongFormCutMode = "tv" | "season" | "series";

export interface LongCutEpisode {
  sourceId: string;
  season: number;
  episode: number;
  title?: string;
  released?: string;
  runtimeSeconds: number;
}

export interface LongCutPlanningConfig {
  finalizeAfterMilliseconds: number;
  allowUnknownReleaseDates: boolean;
  seasonMaxEpisodes: number;
  seriesMaxEpisodes: number;
  seasonMaxEstimatedSeconds: number;
  seriesMaxEstimatedSeconds: number;
  includeSeasonZeroInSeries: boolean;
}

export const DEFAULT_LONG_CUT_PLANNING_CONFIG: LongCutPlanningConfig = {
  finalizeAfterMilliseconds: 14 * 24 * 60 * 60 * 1000,
  allowUnknownReleaseDates: false,
  seasonMaxEpisodes: 30,
  seriesMaxEpisodes: 60,
  seasonMaxEstimatedSeconds: 43_200,
  seriesMaxEstimatedSeconds: 86_400,
  includeSeasonZeroInSeries: false,
};

export type LongCutIneligibilityReason =
  | "still_airing"
  | "unknown_release_dates"
  | "episode_gap"
  | "episode_limit"
  | "duration_limit"
  | "no_normal_seasons";

export interface PlannedLongSeason {
  season: number;
  eligible: boolean;
  episodes: readonly LongCutEpisode[];
  estimatedDurationSeconds: number;
  newestRelease?: string;
  reason?: LongCutIneligibilityReason;
  warnings: readonly string[];
}

export interface PlannedLongSeries {
  eligible: boolean;
  episodes: readonly LongCutEpisode[];
  seasons: readonly number[];
  estimatedDurationSeconds: number;
  reason?: LongCutIneligibilityReason;
  warnings: readonly string[];
}

export interface LongCutPlan {
  seasonCuts: readonly PlannedLongSeason[];
  seriesCut: PlannedLongSeries;
}

function seasonZeroClearlyPrecedesNormalSeasons(
  seasonZero: PlannedLongSeason,
  normalSeasons: readonly PlannedLongSeason[],
): boolean {
  const specialReleases = seasonZero.episodes.map((episode) =>
    episode.released === undefined ? Number.NaN : Date.parse(episode.released),
  );
  const normalReleases = normalSeasons.flatMap((season) =>
    season.episodes.map((episode) =>
      episode.released === undefined ? Number.NaN : Date.parse(episode.released),
    ),
  );
  return (
    specialReleases.length > 0 &&
    normalReleases.length > 0 &&
    specialReleases.every(Number.isFinite) &&
    normalReleases.every(Number.isFinite) &&
    Math.max(...specialReleases) <= Math.min(...normalReleases)
  );
}

export interface VirtualChapter {
  title: string;
  start: number;
  type: "episode";
  sourceEpisodeId: string;
}

function hasGap(episodes: readonly LongCutEpisode[]): boolean {
  return (
    episodes[0]?.episode !== 1 ||
    episodes.some(
      (episode, index) =>
        index > 0 && episode.episode !== episodes[index - 1]!.episode + 1,
    )
  );
}

function planSeason(
  season: number,
  input: readonly LongCutEpisode[],
  now: number,
  config: LongCutPlanningConfig,
): PlannedLongSeason {
  const warnings: string[] = [];
  const unique = new Map<number, LongCutEpisode>();
  for (const episode of input) {
    if (unique.has(episode.episode)) {
      warnings.push(`duplicate_episode:${season}:${episode.episode}`);
      continue;
    }
    unique.set(episode.episode, episode);
  }
  const episodes = [...unique.values()].sort(
    (left, right) => left.episode - right.episode,
  );
  const estimatedDurationSeconds = episodes.reduce(
    (sum, episode) => sum + episode.runtimeSeconds,
    0,
  );
  const base = {
    season,
    episodes,
    estimatedDurationSeconds,
    warnings,
  };
  if (hasGap(episodes))
    return { ...base, eligible: false, reason: "episode_gap" };
  if (episodes.length > config.seasonMaxEpisodes)
    return { ...base, eligible: false, reason: "episode_limit" };
  if (estimatedDurationSeconds > config.seasonMaxEstimatedSeconds)
    return { ...base, eligible: false, reason: "duration_limit" };

  const releaseTimes = episodes.map((episode) =>
    episode.released === undefined ? Number.NaN : Date.parse(episode.released),
  );
  const unknownRelease = releaseTimes.some((value) => !Number.isFinite(value));
  if (unknownRelease && !config.allowUnknownReleaseDates) {
    return { ...base, eligible: false, reason: "unknown_release_dates" };
  }
  const knownReleaseTimes = releaseTimes.filter(Number.isFinite);
  const newestReleaseTime =
    knownReleaseTimes.length === 0 ? undefined : Math.max(...knownReleaseTimes);
  const newestRelease =
    newestReleaseTime === undefined
      ? undefined
      : new Date(newestReleaseTime).toISOString();
  if (
    newestReleaseTime !== undefined &&
    now - newestReleaseTime < config.finalizeAfterMilliseconds
  ) {
    return {
      ...base,
      eligible: false,
      reason: "still_airing",
      ...(newestRelease === undefined ? {} : { newestRelease }),
    };
  }
  return {
    ...base,
    eligible: true,
    ...(newestRelease === undefined ? {} : { newestRelease }),
  };
}

export function planLongCuts(
  input: readonly LongCutEpisode[],
  options: {
    now?: number;
    config?: LongCutPlanningConfig;
  } = {},
): LongCutPlan {
  const now = options.now ?? Date.now();
  const config = options.config ?? DEFAULT_LONG_CUT_PLANNING_CONFIG;
  const bySeason = new Map<number, LongCutEpisode[]>();
  for (const episode of input) {
    const list = bySeason.get(episode.season) ?? [];
    list.push(episode);
    bySeason.set(episode.season, list);
  }
  const seasonCuts = [...bySeason.entries()]
    .sort(([left], [right]) => left - right)
    .map(([season, episodes]) => planSeason(season, episodes, now, config));
  const normalSeasons = seasonCuts.filter((season) => season.season > 0);
  if (normalSeasons.length === 0) {
    return {
      seasonCuts,
      seriesCut: {
        eligible: false,
        episodes: [],
        seasons: [],
        estimatedDurationSeconds: 0,
        reason: "no_normal_seasons",
        warnings: [],
      },
    };
  }
  const seasonZero = seasonCuts.find((season) => season.season === 0);
  const includeSeasonZero =
    config.includeSeasonZeroInSeries &&
    seasonZero !== undefined &&
    seasonZeroClearlyPrecedesNormalSeasons(seasonZero, normalSeasons);
  const includedSeasons = [
    ...(includeSeasonZero && seasonZero !== undefined ? [seasonZero] : []),
    ...normalSeasons,
  ];
  const firstUnavailable = includedSeasons.find((season) => !season.eligible);
  const episodes = includedSeasons.flatMap((season) => [...season.episodes]);
  const estimatedDurationSeconds = episodes.reduce(
    (sum, episode) => sum + episode.runtimeSeconds,
    0,
  );
  const warnings = [
    ...includedSeasons.flatMap((season) => [...season.warnings]),
    ...(config.includeSeasonZeroInSeries &&
    seasonZero !== undefined &&
    !includeSeasonZero
      ? ["season_zero_excluded:ambiguous_order"]
      : []),
  ];
  const base = {
    episodes,
    seasons: includedSeasons.map((season) => season.season),
    estimatedDurationSeconds,
    warnings,
  };
  if (firstUnavailable?.reason !== undefined) {
    return {
      seasonCuts,
      seriesCut: { ...base, eligible: false, reason: firstUnavailable.reason },
    };
  }
  if (episodes.length > config.seriesMaxEpisodes) {
    return {
      seasonCuts,
      seriesCut: { ...base, eligible: false, reason: "episode_limit" },
    };
  }
  if (estimatedDurationSeconds > config.seriesMaxEstimatedSeconds) {
    return {
      seasonCuts,
      seriesCut: { ...base, eligible: false, reason: "duration_limit" },
    };
  }
  return { seasonCuts, seriesCut: { ...base, eligible: true } };
}
