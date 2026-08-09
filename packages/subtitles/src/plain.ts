import type { ParsedPlainSubtitle, SubtitleEvent } from "./types.js";

function parseClock(value: string): number | undefined {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  const hours = Number(match[1] ?? 0),
    minutes = Number(match[2]),
    seconds = Number(match[3]),
    milliseconds = Number(match[4]!.padEnd(3, "0"));
  return minutes > 59 || seconds > 59
    ? undefined
    : hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

export function parseSrt(
  text: string,
  episodeId: string,
  episodeOrder: number,
): ParsedPlainSubtitle {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const events: SubtitleEvent[] = [];
  for (const block of blocks) {
    const lines = block.split("\n"),
      timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = /^\s*(\S+)\s*-->\s*(\S+)\s*$/.exec(lines[timingIndex]!);
    if (timing === null) continue;
    const start = parseClock(timing[1]!),
      end = parseClock(timing[2]!),
      cueText = lines.slice(timingIndex + 1).join("\n");
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      cueText === ""
    )
      continue;
    events.push({
      start,
      end,
      text: cueText,
      sourceEpisodeId: episodeId,
      sourceEpisodeOrder: episodeOrder,
      sourceEventOrder: events.length,
    });
  }
  if (events.length === 0) throw new Error("malformed_srt");
  return { format: "srt", events };
}

export function parseWebVtt(
  text: string,
  episodeId: string,
  episodeOrder: number,
): ParsedPlainSubtitle {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?\n/.test(normalized))
    throw new Error("malformed_vtt");
  const blocks = normalized.slice(normalized.indexOf("\n") + 1).split(/\n{2,}/),
    events: SubtitleEvent[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length === 0 || /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0]!))
      continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = /^\s*(\S+)\s*-->\s*(\S+)(?:\s+(.*))?\s*$/.exec(
      lines[timingIndex]!,
    );
    if (timing === null) continue;
    const start = parseClock(timing[1]!),
      end = parseClock(timing[2]!),
      cueText = lines.slice(timingIndex + 1).join("\n");
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      cueText === ""
    )
      continue;
    events.push({
      start,
      end,
      text: cueText,
      sourceEpisodeId: episodeId,
      sourceEpisodeOrder: episodeOrder,
      sourceEventOrder: events.length,
      ...(timingIndex === 1 ? { cueId: lines[0] } : {}),
      ...(timing[3] === undefined ? {} : { settings: timing[3] }),
    });
  }
  if (events.length === 0) throw new Error("malformed_vtt");
  return { format: "webvtt", events };
}

function formatVttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000),
    hours = Math.floor(ms / 3_600_000),
    minutes = Math.floor((ms % 3_600_000) / 60_000),
    secs = Math.floor((ms % 60_000) / 1000),
    millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
export function composeWebVtt(events: readonly SubtitleEvent[]): string {
  const body = events
    .map(
      (event, index) =>
        `${index + 1}\n${formatVttTime(event.start)} --> ${formatVttTime(event.end)}${event.settings === undefined ? "" : ` ${event.settings}`}\n${event.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}${body === "" ? "" : "\n"}`;
}
