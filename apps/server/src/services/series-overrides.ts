import type {
  SourceEpisodeMeta,
  StremioMetaPreview,
} from "@animetvcut/stremio";

export interface SeriesOverride {
  /** Search query patterns that trigger this override (case-insensitive) */
  queryPatterns: string[];
  /** Preferred video ID when metadata addon returns wrong version */
  preferredVideoId: string;
  /** Name to display */
  displayName: string;
  /** Type of content */
  type: "series";
  /** Genres */
  genres?: string[];
  /** Description */
  description?: string;
  /** Poster image URL */
  poster?: string;
  /** Background image URL */
  background?: string;
  /** MAL anime ID for skip providers */
  malAnimeId?: number;
  /** Episode list when metadata addon doesn't have the series */
  episodes?: Readonly<SourceEpisodeMeta[]>;
  /** Whether to force this override even when metadata returns results */
  forcePreferred?: boolean;
}

/**
 * Known anime/live-action conflicts where the metadata addon
 * returns the wrong version (usually live-action instead of anime).
 * When the metadata search returns no results or only the wrong version,
 * these overrides provide the correct anime metadata.
 */
export const SERIES_OVERRIDES: Readonly<SeriesOverride[]> = Object.freeze([
  {
    queryPatterns: ["great teacher onizuka", "gto"],
    preferredVideoId: "tt0209631",
    displayName: "Great Teacher Onizuka (1998)",
    type: "series",
    genres: ["Comedy", "Drama"],
    description:
      "Eikichi Onizuka, a former biker gang leader and delinquent, has a dream: to become the world's greatest high school teacher. Not just any teacher, but one who can change the lives of his students for the better.",
    poster:
      "https://m.media-amazon.com/images/M/MV5BNDIzNjg1NjEtMjRjYi00NjJhLWI5NjItZjI3MjA4MjE0YjE5XkEyXkFqcGc@._V1_.jpg",
    background:
      "https://m.media-amazon.com/images/M/MV5BNDIzNjg1NjEtMjRjYi00NjJhLWI5NjItZjI3MjA4MjE0YjE5XkEyXkFqcGc@._V1_.jpg",
    malAnimeId: 245,
    episodes: Object.freeze(
      Array.from({ length: 43 }, (_, i) => ({
        id: `tt0209631:${i + 1}`,
        season: 1,
        episode: i + 1,
        runtimeSeconds: 24 * 60,
      })),
    ),
    forcePreferred: true,
  },
]);

/**
 * Check if a search query matches any series override.
 */
export function findSeriesOverride(query: string): SeriesOverride | undefined {
  const normalized = query.toLowerCase().trim();
  return SERIES_OVERRIDES.find((override) =>
    override.queryPatterns.some((pattern) => normalized.includes(pattern)),
  );
}

/**
 * Convert a series override to a StremioMetaPreview.
 */
export function overrideToMetaPreview(
  override: SeriesOverride,
  videoId: string,
): StremioMetaPreview {
  return {
    id: videoId,
    name: override.displayName,
    type: override.type,
    ...(override.genres !== undefined ? { genres: override.genres } : {}),
    ...(override.description !== undefined
      ? { description: override.description }
      : {}),
    ...(override.poster !== undefined ? { poster: override.poster } : {}),
    ...(override.background !== undefined
      ? { background: override.background }
      : {}),
  };
}

/**
 * Check if a source ID matches any series override.
 */
export function findSeriesOverrideById(
  sourceId: string,
): SeriesOverride | undefined {
  return SERIES_OVERRIDES.find(
    (override) => override.preferredVideoId === sourceId,
  );
}
