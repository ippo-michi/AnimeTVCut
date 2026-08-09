export function redactManifestUrl(rawUrl: string | URL): string {
  try {
    const url = new URL(rawUrl.toString());
    return `${url.origin}/<redacted-manifest-path>`;
  } catch {
    return "<invalid-manifest-url>";
  }
}

export function manifestOrigin(rawUrl: string | URL): string {
  try {
    return new URL(rawUrl.toString()).origin;
  } catch {
    return "<invalid-origin>";
  }
}
