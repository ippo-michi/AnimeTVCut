import { createHash } from "node:crypto";

import type { LongFormCutMode } from "@animetvcut/core";

import { InvalidVirtualStremioIdError } from "./errors.js";

const META_PREFIX = "atc:tv:";
const MODE_PREFIX: Readonly<Record<LongFormCutMode, string>> = {
  tv: META_PREFIX,
  season: "atc:season:",
  series: "atc:series:",
};
const MAX_SOURCE_ID_BYTES = 512;
const MAX_EPISODE_SPAN = 32;

function encodeSourceId(sourceId: string): string {
  const byteLength = Buffer.byteLength(sourceId, "utf8");
  if (byteLength === 0 || byteLength > MAX_SOURCE_ID_BYTES) {
    throw new InvalidVirtualStremioIdError(
      "Source metadata ID has an invalid size.",
    );
  }
  return Buffer.from(sourceId, "utf8").toString("base64url");
}

function decodeSourceId(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 1024) {
    throw new InvalidVirtualStremioIdError("Virtual Stremio ID is malformed.");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (encodeSourceId(decoded) !== encoded) {
    throw new InvalidVirtualStremioIdError(
      "Virtual Stremio ID is not canonical.",
    );
  }
  return decoded;
}

export function createVirtualMetaId(sourceId: string): string {
  return `${META_PREFIX}${encodeSourceId(sourceId)}`;
}

export function createLongFormVirtualMetaId(
  mode: LongFormCutMode,
  sourceId: string,
): string {
  return `${MODE_PREFIX[mode]}${encodeSourceId(sourceId)}`;
}

export function parseLongFormVirtualMetaId(value: string): {
  mode: LongFormCutMode;
  sourceId: string;
} {
  const entry = (
    Object.entries(MODE_PREFIX) as [LongFormCutMode, string][]
  ).find(([, prefix]) => value.startsWith(prefix));
  if (entry === undefined)
    throw new InvalidVirtualStremioIdError(
      "Virtual metadata ID has an invalid prefix.",
    );
  const [mode, prefix] = entry;
  const encoded = value.slice(prefix.length);
  if (encoded.includes(":"))
    throw new InvalidVirtualStremioIdError("Virtual metadata ID is malformed.");
  return { mode, sourceId: decodeSourceId(encoded) };
}

export function parseVirtualMetaId(value: string): { sourceId: string } {
  if (!value.startsWith(META_PREFIX)) {
    throw new InvalidVirtualStremioIdError(
      "Virtual metadata ID has an invalid prefix.",
    );
  }
  const encoded = value.slice(META_PREFIX.length);
  if (encoded.includes(":")) {
    throw new InvalidVirtualStremioIdError("Virtual metadata ID is malformed.");
  }
  return { sourceId: decodeSourceId(encoded) };
}

export function createSeasonCutVideoId(
  sourceId: string,
  season: number,
  firstEpisode: number,
  lastEpisode: number,
): string {
  if (
    !Number.isSafeInteger(season) ||
    season < 0 ||
    !Number.isSafeInteger(firstEpisode) ||
    firstEpisode < 1 ||
    !Number.isSafeInteger(lastEpisode) ||
    lastEpisode < firstEpisode ||
    lastEpisode - firstEpisode + 1 > 128
  )
    throw new InvalidVirtualStremioIdError(
      "Season Cut coordinates are invalid.",
    );
  return `${MODE_PREFIX.season}${encodeSourceId(sourceId)}:s${season}:e${firstEpisode}-${lastEpisode}`;
}

export function parseSeasonCutVideoId(value: string): {
  mode: "season";
  sourceId: string;
  season: number;
  firstEpisode: number;
  lastEpisode: number;
} {
  const match = /^atc:season:([A-Za-z0-9_-]+):s(\d+):e(\d+)-(\d+)$/.exec(value);
  if (match === null)
    throw new InvalidVirtualStremioIdError("Season Cut video ID is malformed.");
  const sourceId = decodeSourceId(match[1]!);
  const season = Number(match[2]);
  const firstEpisode = Number(match[3]);
  const lastEpisode = Number(match[4]);
  if (
    createSeasonCutVideoId(sourceId, season, firstEpisode, lastEpisode) !==
    value
  )
    throw new InvalidVirtualStremioIdError(
      "Season Cut video ID is not canonical.",
    );
  return { mode: "season", sourceId, season, firstEpisode, lastEpisode };
}

export interface SeriesVersionEpisode {
  id: string;
  season: number;
  episode: number;
}

export function createSeriesCutVersion(
  episodes: readonly SeriesVersionEpisode[],
): string {
  if (episodes.length === 0 || episodes.length > 256)
    throw new InvalidVirtualStremioIdError(
      "Complete Cut episode set is invalid.",
    );
  const canonical = episodes
    .map((item) => `${item.season}\0${item.episode}\0${item.id}`)
    .join("\n");
  return createHash("sha256")
    .update(canonical)
    .digest("base64url")
    .slice(0, 22);
}

export function createSeriesCutVideoId(
  sourceId: string,
  episodes: readonly SeriesVersionEpisode[],
): string {
  return `${MODE_PREFIX.series}${encodeSourceId(sourceId)}:v${createSeriesCutVersion(episodes)}`;
}

export function parseSeriesCutVideoId(value: string): {
  mode: "series";
  sourceId: string;
  version: string;
} {
  const match = /^atc:series:([A-Za-z0-9_-]+):v([A-Za-z0-9_-]{22})$/.exec(
    value,
  );
  if (match === null)
    throw new InvalidVirtualStremioIdError(
      "Complete Cut video ID is malformed.",
    );
  return {
    mode: "series",
    sourceId: decodeSourceId(match[1]!),
    version: match[2]!,
  };
}

export function createVirtualVideoId(
  sourceId: string,
  season: number,
  firstEpisode: number,
  lastEpisode: number,
): string {
  if (
    !Number.isSafeInteger(season) ||
    season < 0 ||
    !Number.isSafeInteger(firstEpisode) ||
    firstEpisode < 1 ||
    !Number.isSafeInteger(lastEpisode) ||
    lastEpisode < firstEpisode ||
    lastEpisode - firstEpisode + 1 > MAX_EPISODE_SPAN
  ) {
    throw new InvalidVirtualStremioIdError(
      "Virtual video coordinates are invalid.",
    );
  }
  return `${META_PREFIX}${encodeSourceId(sourceId)}:s${season}:e${firstEpisode}-${lastEpisode}`;
}

export function parseVirtualVideoId(value: string): {
  sourceId: string;
  season: number;
  firstEpisode: number;
  lastEpisode: number;
} {
  const match = /^atc:tv:([A-Za-z0-9_-]+):s(\d+):e(\d+)-(\d+)$/.exec(value);
  if (match === null) {
    throw new InvalidVirtualStremioIdError("Virtual video ID is malformed.");
  }
  const season = Number(match[2]);
  const firstEpisode = Number(match[3]);
  const lastEpisode = Number(match[4]);
  const sourceId = decodeSourceId(match[1]!);
  if (
    createVirtualVideoId(sourceId, season, firstEpisode, lastEpisode) !== value
  ) {
    throw new InvalidVirtualStremioIdError(
      "Virtual video ID is not canonical.",
    );
  }
  return { sourceId, season, firstEpisode, lastEpisode };
}
