import { InvalidVirtualStremioIdError } from "./errors.js";

const META_PREFIX = "atc:tv:";
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
