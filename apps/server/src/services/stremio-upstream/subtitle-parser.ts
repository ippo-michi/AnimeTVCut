import type { UpstreamSubtitle } from "./types.js";

const MAX_RESULTS = 200,
  MAX_ID = 256,
  MAX_LANG = 64,
  MAX_URL = 16_384;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseStremioSubtitleResponse(
  value: unknown,
): readonly UpstreamSubtitle[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.subtitles) ||
    value.subtitles.length > MAX_RESULTS
  )
    throw new Error("invalid_subtitle_resource_response");
  return value.subtitles.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > MAX_ID ||
      [...entry.id].some(
        (character) =>
          character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      ) ||
      typeof entry.lang !== "string" ||
      entry.lang.length === 0 ||
      entry.lang.length > MAX_LANG ||
      [...entry.lang].some(
        (character) =>
          character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      ) ||
      typeof entry.url !== "string" ||
      entry.url.length === 0 ||
      entry.url.length > MAX_URL
    )
      return [];
    try {
      const url = new URL(entry.url);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== ""
      )
        return [];
      return [
        {
          id: entry.id,
          lang: entry.lang,
          url: url.toString(),
          source: "subtitle_resource" as const,
        },
      ];
    } catch {
      return [];
    }
  });
}
