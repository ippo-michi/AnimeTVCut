import type { SubtitleOutputFormat, SubtitleSourceFormat } from "./types.js";
import { decodeSubtitleBytes } from "./encoding.js";

export function formatHintFromUrl(
  urlText: string,
): SubtitleSourceFormat | undefined {
  try {
    const path = new URL(urlText).pathname.toLowerCase();
    for (const format of ["srt", "vtt", "ass", "ssa"] as const) {
      if (path.endsWith(`.${format}`))
        return format === "vtt" ? "webvtt" : format;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function detectSubtitleFormat(
  bytes: Uint8Array,
  contentType?: string,
  hint?: SubtitleSourceFormat,
): SubtitleSourceFormat | undefined {
  let decoded: string;
  try {
    decoded = decodeSubtitleBytes(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    );
  } catch {
    return undefined;
  }
  const prefix = decoded.replace(/^\uFEFF/, "").trimStart();
  if (/^WEBVTT(?:\s|$)/.test(prefix)) return "webvtt";
  if (/^\[(?:Script Info|V4\+? Styles|Events)\]/im.test(prefix))
    return /ScriptType\s*:\s*v4\.00\+/i.test(prefix)
      ? "ass"
      : hint === "ssa"
        ? "ssa"
        : "ass";
  if (/^\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(prefix)) return "srt";
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/vtt" &&
    /^WEBVTT(?:\s|$)/.test(prefix)
  )
    return "webvtt";
  return undefined;
}

export function outputFormatForSources(
  formats: readonly SubtitleSourceFormat[],
): SubtitleOutputFormat | undefined {
  if (formats.length === 0) return undefined;
  if (formats.every((format) => format === "srt" || format === "webvtt"))
    return "webvtt";
  if (formats.every((format) => format === "ass" || format === "ssa"))
    return "ass";
  return undefined;
}
