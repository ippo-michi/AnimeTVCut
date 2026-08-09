import type {
  ExplicitSkipIdentity,
  ImdbSkipIdentity,
  SkipLookupIdentity,
} from "./models.js";

const IMDB_EPISODE_PATTERN = /^(tt\d{7,8}):(\d+):(\d+)$/;

export function extractImdbSkipIdentity(
  videoId: string,
): ImdbSkipIdentity | undefined {
  const match = IMDB_EPISODE_PATTERN.exec(videoId);
  if (match === null) return undefined;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (
    !Number.isSafeInteger(season) ||
    season < 1 ||
    !Number.isSafeInteger(episode) ||
    episode < 1
  ) {
    return undefined;
  }
  return { id: match[1]!, season, episode };
}

export function deriveSkipLookupIdentity(
  videoId: string,
  explicit?: ExplicitSkipIdentity,
): SkipLookupIdentity {
  const imdb = extractImdbSkipIdentity(videoId);
  const hasCompleteMalIdentity =
    explicit?.malAnimeId !== undefined && explicit.malEpisode !== undefined;
  const mal = hasCompleteMalIdentity
    ? { animeId: explicit.malAnimeId!, episode: explicit.malEpisode! }
    : undefined;
  return {
    ...(imdb === undefined ? {} : { imdb }),
    ...(mal === undefined ? {} : { mal }),
  };
}
