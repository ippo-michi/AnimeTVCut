import { MetadataStremioConfigurationError } from "./errors.js";

export function parseManifestUrl(value: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MetadataStremioConfigurationError(
      "Metadata Stremio manifest URL is invalid.",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new MetadataStremioConfigurationError(
      "Metadata Stremio manifest URL must use HTTP or HTTPS.",
    );
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new MetadataStremioConfigurationError(
      "Metadata Stremio manifest URL contains unsupported credentials or fragment.",
    );
  }
  if (!parsed.pathname.endsWith("/manifest.json")) {
    throw new MetadataStremioConfigurationError(
      "Metadata Stremio manifest URL must end with /manifest.json.",
    );
  }
  return parsed;
}

export function deriveStremioResourceUrl(
  manifestUrl: URL,
  segments: readonly string[],
  extra?: Readonly<Record<string, string | number>>,
): URL {
  const addonDirectory = new URL("./", manifestUrl);
  const encodedSegments = segments.map((segment) =>
    encodeURIComponent(segment),
  );
  let resourcePath = encodedSegments.join("/");
  if (extra !== undefined && Object.keys(extra).length > 0) {
    const encodedExtra = Object.entries(extra)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      )
      .join("&");
    resourcePath += `/${encodedExtra}`;
  }
  const resourceUrl = new URL(`${resourcePath}.json`, addonDirectory);
  resourceUrl.search = manifestUrl.search;
  return resourceUrl;
}

export function safeManifestOrigin(manifestUrl: URL): string {
  return manifestUrl.origin;
}
