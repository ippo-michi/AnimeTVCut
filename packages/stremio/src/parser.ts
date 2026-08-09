import {
  MetadataStremioCompatibilityError,
  MetadataStremioInvalidResponseError,
} from "./errors.js";
import type {
  MetadataStremioManifest,
  SourceEpisodeMeta,
  SourceSeriesMeta,
  StremioCatalogDeclaration,
  StremioMetaPreview,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new MetadataStremioInvalidResponseError(
      `Metadata Stremio response has an invalid ${name}.`,
    );
  }
  return value;
}

function optionalString(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new MetadataStremioInvalidResponseError(
      `Metadata Stremio response has invalid ${name}.`,
    );
  }
  return value.map((item) => requiredString(item, name, 128));
}

function parseResource(value: unknown): string {
  if (typeof value === "string") return requiredString(value, "resource", 128);
  if (isRecord(value)) return requiredString(value.name, "resource name", 128);
  throw new MetadataStremioInvalidResponseError(
    "Metadata Stremio manifest has an invalid resource.",
  );
}

function parseCatalog(value: unknown): StremioCatalogDeclaration {
  if (!isRecord(value)) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio manifest has an invalid catalog.",
    );
  }
  const extra = value.extra === undefined ? [] : value.extra;
  if (!Array.isArray(extra) || extra.length > 32) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio manifest has invalid catalog extras.",
    );
  }
  const name = optionalString(value.name, 256);
  return {
    id: requiredString(value.id, "catalog id", 256),
    type: requiredString(value.type, "catalog type", 64),
    ...(name === undefined ? {} : { name }),
    extra: extra.map((item) => {
      if (!isRecord(item)) {
        throw new MetadataStremioInvalidResponseError(
          "Metadata Stremio manifest has an invalid catalog extra.",
        );
      }
      return {
        name: requiredString(item.name, "catalog extra name", 64),
        isRequired: item.isRequired === true,
      };
    }),
  };
}

export function parseMetadataManifest(value: unknown): MetadataStremioManifest {
  if (!isRecord(value) || !Array.isArray(value.resources)) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio manifest is invalid.",
    );
  }
  const resources = value.resources.map(parseResource);
  const types = stringArray(value.types, "manifest types");
  if (
    !types.includes("series") ||
    !resources.includes("meta") ||
    !resources.includes("catalog")
  ) {
    throw new MetadataStremioCompatibilityError(
      "Metadata Stremio addon must support series catalog and meta resources.",
    );
  }
  if (!Array.isArray(value.catalogs)) {
    throw new MetadataStremioCompatibilityError(
      "Metadata Stremio addon has no compatible series search catalog.",
    );
  }
  return {
    id: requiredString(value.id, "manifest id", 256),
    name: requiredString(value.name, "manifest name", 256),
    version: requiredString(value.version, "manifest version", 64),
    types,
    resources,
    catalogs: value.catalogs.map(parseCatalog),
  };
}

function parsePreview(value: unknown): StremioMetaPreview {
  if (!isRecord(value) || value.type !== "series") {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio catalog contains an invalid series item.",
    );
  }
  const take = (key: string, max = 4096) => optionalString(value[key], max);
  const poster = take("poster", 2048);
  const posterShape = take("posterShape", 64);
  const background = take("background", 2048);
  const logo = take("logo", 2048);
  const description = take("description");
  const releaseInfo = take("releaseInfo", 256);
  const imdbRating = take("imdbRating", 64);
  const genres =
    Array.isArray(value.genres) && value.genres.length <= 64
      ? value.genres
          .map((genre) => optionalString(genre, 128))
          .filter((genre): genre is string => genre !== undefined)
      : undefined;
  return {
    id: requiredString(value.id, "series id", 1024),
    type: "series",
    name: requiredString(value.name, "series name", 512),
    ...(poster === undefined ? {} : { poster }),
    ...(posterShape === undefined ? {} : { posterShape }),
    ...(background === undefined ? {} : { background }),
    ...(logo === undefined ? {} : { logo }),
    ...(description === undefined ? {} : { description }),
    ...(releaseInfo === undefined ? {} : { releaseInfo }),
    ...(imdbRating === undefined ? {} : { imdbRating }),
    ...(genres === undefined ? {} : { genres }),
  };
}

export function parseCatalogResponse(
  value: unknown,
): readonly StremioMetaPreview[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.metas) ||
    value.metas.length > 500
  ) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio catalog response is invalid.",
    );
  }
  return value.metas.map(parsePreview);
}

function parseEpisode(value: unknown): SourceEpisodeMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.season) ||
    Number(value.season) < 0 ||
    !Number.isSafeInteger(value.episode) ||
    Number(value.episode) < 1
  ) {
    return undefined;
  }
  const title = optionalString(value.title, 512);
  const released = optionalString(value.released, 128);
  const thumbnail = optionalString(value.thumbnail, 2048);
  return {
    id: requiredString(value.id, "episode id", 1024),
    season: Number(value.season),
    episode: Number(value.episode),
    ...(title === undefined ? {} : { title }),
    ...(released === undefined ? {} : { released }),
    ...(thumbnail === undefined ? {} : { thumbnail }),
  };
}

export function parseMetaResponse(
  value: unknown,
  parseRuntime: (runtime: unknown) => number | undefined,
): SourceSeriesMeta {
  if (!isRecord(value) || !isRecord(value.meta)) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio meta response is invalid.",
    );
  }
  const preview = parsePreview(value.meta);
  if (!Array.isArray(value.meta.videos) || value.meta.videos.length > 10_000) {
    throw new MetadataStremioInvalidResponseError(
      "Metadata Stremio series videos are invalid.",
    );
  }
  const runtimeSeconds = parseRuntime(value.meta.runtime);
  return {
    ...preview,
    ...(runtimeSeconds === undefined ? {} : { runtimeSeconds }),
    videos: value.meta.videos
      .map(parseEpisode)
      .filter((episode): episode is SourceEpisodeMeta => episode !== undefined),
  };
}

export function selectSearchCatalog(
  manifest: MetadataStremioManifest,
  configuredId?: string,
): StremioCatalogDeclaration {
  const compatible = manifest.catalogs.filter(
    (catalog) =>
      catalog.type === "series" &&
      catalog.extra.some((extra) => extra.name === "search"),
  );
  const selected =
    configuredId === undefined
      ? compatible[0]
      : compatible.find((catalog) => catalog.id === configuredId);
  if (selected === undefined) {
    throw new MetadataStremioCompatibilityError(
      configuredId === undefined
        ? "Metadata Stremio addon has no compatible series search catalog."
        : "Configured metadata Stremio search catalog is unavailable or incompatible.",
    );
  }
  return selected;
}
