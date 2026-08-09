import {
  StremioManifestCompatibilityError,
  StremioManifestInvalidError,
} from "./errors.js";
import type {
  StremioManifest,
  StremioManifestResource,
  UpstreamEpisodeReference,
} from "./types.js";
import { deriveStremioResourceUrl } from "@animetvcut/stremio";

const MAX_TEXT_FIELD_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maximum = MAX_TEXT_FIELD_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new StremioManifestInvalidError(
      `Upstream Stremio manifest has an invalid ${field}.`,
    );
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new StremioManifestInvalidError(
      `Upstream Stremio manifest has invalid ${field}.`,
    );
  }
  return value.map((item) => requiredString(item, field, 128));
}

function parseResource(value: unknown): StremioManifestResource {
  if (typeof value === "string")
    return { name: requiredString(value, "resource") };
  if (!isRecord(value)) {
    throw new StremioManifestInvalidError(
      "Upstream Stremio manifest has an invalid resource declaration.",
    );
  }
  const types = optionalStringArray(value.types, "resource types");
  const idPrefixes = optionalStringArray(
    value.idPrefixes,
    "resource idPrefixes",
  );
  return {
    name: requiredString(value.name, "resource name"),
    ...(types === undefined ? {} : { types }),
    ...(idPrefixes === undefined ? {} : { idPrefixes }),
  };
}

export function parseStremioManifest(value: unknown): StremioManifest {
  if (!isRecord(value)) {
    throw new StremioManifestInvalidError(
      "Upstream Stremio manifest must be a JSON object.",
    );
  }
  if (!Array.isArray(value.resources) || value.resources.length === 0) {
    throw new StremioManifestInvalidError(
      "Upstream Stremio manifest is missing resources.",
    );
  }
  const resources = value.resources.map(parseResource);
  if (!resources.some((resource) => resource.name === "stream")) {
    throw new StremioManifestInvalidError(
      "Upstream Stremio manifest does not support stream resources.",
    );
  }
  const types = optionalStringArray(value.types, "types") ?? [];
  const idPrefixes = optionalStringArray(value.idPrefixes, "idPrefixes");
  return {
    id: requiredString(value.id, "id"),
    name: requiredString(value.name, "name"),
    version: requiredString(value.version, "version"),
    types,
    ...(idPrefixes === undefined ? {} : { idPrefixes }),
    resources,
  };
}

export function assertManifestSupportsReference(
  manifest: StremioManifest,
  reference: UpstreamEpisodeReference,
): void {
  const streamResources = manifest.resources.filter(
    (resource) => resource.name === "stream",
  );
  const compatible = streamResources.some((resource) => {
    const types = resource.types ?? manifest.types;
    if (types.length > 0 && !types.includes(reference.type)) return false;
    const prefixes = resource.idPrefixes ?? manifest.idPrefixes;
    return (
      prefixes === undefined ||
      prefixes.some((prefix) => reference.videoId.startsWith(prefix))
    );
  });
  if (!compatible) {
    throw new StremioManifestCompatibilityError(
      `Upstream Stremio manifest does not support ${reference.type} resource ${reference.videoId}.`,
    );
  }
}

export function buildStreamResourceUrl(
  manifestUrl: URL,
  reference: UpstreamEpisodeReference,
): URL {
  return deriveStremioResourceUrl(manifestUrl, [
    "stream",
    reference.type,
    reference.videoId,
  ]);
}

export function manifestSupportsSubtitles(
  manifest: StremioManifest,
  reference: UpstreamEpisodeReference,
): boolean {
  return manifest.resources
    .filter((resource) => resource.name === "subtitles")
    .some((resource) => {
      const types = resource.types ?? manifest.types;
      return types.length === 0 || types.includes(reference.type);
    });
}

export function buildSubtitleResourceUrl(
  manifestUrl: URL,
  reference: UpstreamEpisodeReference,
  videoHash: string,
  videoSize?: number,
): URL {
  return deriveStremioResourceUrl(
    manifestUrl,
    ["subtitles", reference.type, videoHash],
    {
      videoID: reference.videoId,
      ...(videoSize === undefined ? {} : { videoSize }),
    },
  );
}
