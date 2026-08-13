export interface TvCutGroupingConfig {
  episodesPerGroup: number;
  targetSeconds: number;
  minimumSeconds: number;
  maximumSeconds: number;
  maximumEpisodes: number;
  assumedOpeningSeconds: number;
  assumedEndingSeconds: number;
  trailingGraceMilliseconds: number;
  fallbackRuntimeSeconds: number;
}

export const DEFAULT_TV_CUT_GROUPING_CONFIG: TvCutGroupingConfig = {
  episodesPerGroup: 3,
  targetSeconds: 3600,
  minimumSeconds: 3000,
  maximumSeconds: 4500,
  maximumEpisodes: 4,
  assumedOpeningSeconds: 90,
  assumedEndingSeconds: 90,
  trailingGraceMilliseconds: 14 * 24 * 60 * 60 * 1000,
  fallbackRuntimeSeconds: 1440,
};

export interface GroupableEpisode {
  sourceId: string;
  season: number;
  episode: number;
  released?: string;
  runtimeSeconds?: number;
}

export interface TvCutGroup {
  season: number;
  firstEpisode: number;
  lastEpisode: number;
  episodes: readonly GroupableEpisode[];
  estimatedDurationSeconds: number;
  latestRelease?: string;
  finalized: boolean;
}

export interface TvCutGroupingResult {
  groups: readonly TvCutGroup[];
  warnings: readonly string[];
}

export function estimatedCutDuration(
  episodes: readonly GroupableEpisode[],
  config: TvCutGroupingConfig,
): number {
  const raw = episodes.reduce(
    (sum, episode) =>
      sum + (episode.runtimeSeconds ?? config.fallbackRuntimeSeconds),
    0,
  );
  if (episodes.length <= 1) return raw;
  return Math.max(
    0,
    raw -
      (episodes.length - 1) *
        (config.assumedOpeningSeconds + config.assumedEndingSeconds),
  );
}

function latestRelease(
  episodes: readonly GroupableEpisode[],
): string | undefined {
  return episodes
    .map((episode) => episode.released)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
}

function isTrailingGroupFinal(
  episodes: readonly GroupableEpisode[],
  now: number,
  config: TvCutGroupingConfig,
): boolean {
  const latest = latestRelease(episodes);
  if (latest === undefined) return false;
  const releasedAt = Date.parse(latest);
  return (
    Number.isFinite(releasedAt) &&
    now - releasedAt >= config.trailingGraceMilliseconds
  );
}

function makeGroup(
  episodes: readonly GroupableEpisode[],
  finalized: boolean,
  config: TvCutGroupingConfig,
): TvCutGroup {
  const first = episodes[0]!;
  const last = episodes.at(-1)!;
  const latest = latestRelease(episodes);
  return {
    season: first.season,
    firstEpisode: first.episode,
    lastEpisode: last.episode,
    episodes,
    estimatedDurationSeconds: estimatedCutDuration(episodes, config),
    ...(latest === undefined ? {} : { latestRelease: latest }),
    finalized,
  };
}

function splitConsecutiveRuns(
  episodes: readonly GroupableEpisode[],
): GroupableEpisode[][] {
  const runs: GroupableEpisode[][] = [];
  for (const episode of episodes) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (
      current === undefined ||
      previous === undefined ||
      previous.season !== episode.season ||
      previous.episode + 1 !== episode.episode
    ) {
      runs.push([episode]);
    } else {
      current.push(episode);
    }
  }
  return runs;
}

export function groupTvCutEpisodes(
  input: readonly GroupableEpisode[],
  options: { now?: number; config?: TvCutGroupingConfig } = {},
): TvCutGroupingResult {
  const now = options.now ?? Date.now();
  const config = options.config ?? DEFAULT_TV_CUT_GROUPING_CONFIG;
  const warnings: string[] = [];
  const unique = new Map<string, GroupableEpisode>();
  for (const episode of input) {
    const key = `${episode.season}:${episode.episode}`;
    if (unique.has(key)) {
      warnings.push(
        `Ignored duplicate season ${episode.season} episode ${episode.episode}.`,
      );
      continue;
    }
    if (episode.released !== undefined) {
      const releasedAt = Date.parse(episode.released);
      if (!Number.isFinite(releasedAt)) {
        warnings.push(
          `Ignored invalid release date for season ${episode.season} episode ${episode.episode}.`,
        );
      } else if (releasedAt > now) {
        continue;
      }
    }
    unique.set(key, episode);
  }
  const episodes = [...unique.values()].sort(
    (left, right) => left.season - right.season || left.episode - right.episode,
  );
  const groups: TvCutGroup[] = [];
  for (const run of splitConsecutiveRuns(episodes)) {
    const episodesPerGroup = Math.max(
      1,
      Math.min(config.episodesPerGroup, config.maximumEpisodes),
    );
    let cursor = 0;
    while (cursor < run.length) {
      const selected = run.slice(cursor, cursor + episodesPerGroup);
      cursor += selected.length;
      const isTrailing = cursor === run.length;
      const finalized =
        selected.length === episodesPerGroup ||
        !isTrailing ||
        isTrailingGroupFinal(selected, now, config);
      groups.push(makeGroup(selected, finalized, config));
    }
  }
  return { groups, warnings };
}
