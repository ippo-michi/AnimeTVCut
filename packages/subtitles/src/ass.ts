import type { AssStyle, ParsedAssSubtitle, SubtitleEvent } from "./types.js";

function parseAssTime(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]),
    minutes = Number(match[2]),
    seconds = Number(match[3]),
    centis = Number(match[4]!.padEnd(2, "0"));
  return minutes > 59 || seconds > 59
    ? undefined
    : hours * 3600 + minutes * 60 + seconds + centis / 100;
}

function splitColumns(value: string, count: number): string[] {
  const values: string[] = [];
  let cursor = value;
  for (let index = 1; index < count; index += 1) {
    const comma = cursor.indexOf(",");
    if (comma < 0) return [];
    values.push(cursor.slice(0, comma).trim());
    cursor = cursor.slice(comma + 1);
  }
  values.push(cursor);
  return values;
}

export function parseAss(
  text: string,
  episodeId: string,
  episodeOrder: number,
  hint: "ass" | "ssa" = "ass",
): ParsedAssSubtitle {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let section = "",
    styleFormat: string[] = [],
    eventFormat: string[] = [];
  let playResX: number | undefined, playResY: number | undefined;
  const styles: AssStyle[] = [],
    events: SubtitleEvent[] = [],
    scriptInfo: string[] = [],
    attachments: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd(),
      sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1]!.toLowerCase();
      continue;
    }
    if (section === "script info") {
      if (/^PlayResX\s*:/i.test(line)) {
        const value = Number(line.split(":", 2)[1]);
        if (Number.isFinite(value) && value > 0) playResX = value;
      } else if (/^PlayResY\s*:/i.test(line)) {
        const value = Number(line.split(":", 2)[1]);
        if (Number.isFinite(value) && value > 0) playResY = value;
      }
      if (
        !/^ScriptType\s*:/i.test(line) &&
        !/^PlayRes[XY]\s*:/i.test(line) &&
        line.trim() !== ""
      )
        scriptInfo.push(line);
    } else if (section === "v4+ styles" || section === "v4 styles") {
      if (/^Format\s*:/i.test(line))
        styleFormat = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((item) => item.trim());
      else if (/^Style\s*:/i.test(line) && styleFormat.length > 0) {
        const fields = splitColumns(
            line.slice(line.indexOf(":") + 1),
            styleFormat.length,
          ),
          nameIndex = styleFormat.findIndex(
            (field) => field.toLowerCase() === "name",
          );
        if (
          fields.length === styleFormat.length &&
          nameIndex >= 0 &&
          fields[nameIndex] !== ""
        )
          styles.push({ name: fields[nameIndex]!, fields });
      }
    } else if (section === "events") {
      if (/^Format\s*:/i.test(line))
        eventFormat = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((item) => item.trim());
      else if (
        /^(Dialogue|Comment)\s*:/i.test(line) &&
        eventFormat.length > 0
      ) {
        const kind = line.slice(0, line.indexOf(":")),
          fields = splitColumns(
            line.slice(line.indexOf(":") + 1),
            eventFormat.length,
          );
        const startIndex = eventFormat.findIndex(
            (field) => field.toLowerCase() === "start",
          ),
          endIndex = eventFormat.findIndex(
            (field) => field.toLowerCase() === "end",
          ),
          textIndex = eventFormat.findIndex(
            (field) => field.toLowerCase() === "text",
          );
        const start =
            startIndex < 0 ? undefined : parseAssTime(fields[startIndex] ?? ""),
          end = endIndex < 0 ? undefined : parseAssTime(fields[endIndex] ?? "");
        if (
          fields.length === eventFormat.length &&
          start !== undefined &&
          end !== undefined &&
          end > start &&
          textIndex >= 0
        ) {
          const record: Record<string, string> = { __kind: kind };
          eventFormat.forEach((field, index) => {
            record[field.toLowerCase()] = fields[index]!;
          });
          events.push({
            start,
            end,
            text: fields[textIndex]!,
            sourceEpisodeId: episodeId,
            sourceEpisodeOrder: episodeOrder,
            sourceEventOrder: events.length,
            assFields: record,
          });
        }
      }
    } else if (section === "fonts" || section === "graphics")
      attachments.push(
        `[${section === "fonts" ? "Fonts" : "Graphics"}]\n${line}`,
      );
  }
  if (
    styleFormat.length === 0 ||
    styles.length === 0 ||
    eventFormat.length === 0 ||
    events.length === 0
  )
    throw new Error("malformed_ass");
  return {
    format: hint,
    ...(playResX === undefined ? {} : { playResX }),
    ...(playResY === undefined ? {} : { playResY }),
    styleFormat,
    styles,
    eventFormat,
    events,
    scriptInfo,
    attachments,
  };
}

function safeStylePrefix(episodeOrder: number): string {
  return `E${episodeOrder + 1}_`;
}
function rewriteResetStyles(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  return text.replace(/\\r([^\\}]+)/g, (match, name: string) =>
    names.get(name) === undefined ? match : `\\r${names.get(name)!}`,
  );
}
function formatAssTime(seconds: number): string {
  const centiseconds = Math.round(seconds * 100),
    hours = Math.floor(centiseconds / 360000),
    minutes = Math.floor((centiseconds % 360000) / 6000),
    secs = Math.floor((centiseconds % 6000) / 100),
    cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function composeAss(
  parsed: readonly ParsedAssSubtitle[],
  mappedEvents: readonly SubtitleEvent[],
): string {
  const geometry = parsed.map(
    (item) => `${item.playResX ?? ""}x${item.playResY ?? ""}`,
  );
  if (new Set(geometry).size > 1) throw new Error("incompatible_ass_geometry");
  const styleFormat = parsed[0]?.styleFormat;
  const eventFormat = parsed[0]?.eventFormat;
  if (
    styleFormat === undefined ||
    eventFormat === undefined ||
    parsed.some(
      (item) =>
        item.styleFormat.join("\0").toLowerCase() !==
          styleFormat.join("\0").toLowerCase() ||
        item.eventFormat.join("\0").toLowerCase() !==
          eventFormat.join("\0").toLowerCase(),
    )
  )
    throw new Error("incompatible_ass_format");
  const nameIndex = styleFormat.findIndex(
    (field) => field.toLowerCase() === "name",
  );
  const styleMaps = parsed.map(
    (item, episodeOrder) =>
      new Map(
        item.styles.map((style) => [
          style.name,
          `${safeStylePrefix(episodeOrder)}${style.name}`,
        ]),
      ),
  );
  const styleLines = parsed.flatMap((item, episodeOrder) =>
    item.styles.map((style) => {
      const fields = [...style.fields];
      fields[nameIndex] = styleMaps[episodeOrder]!.get(style.name)!;
      return `Style: ${fields.join(",")}`;
    }),
  );
  const eventLines = mappedEvents.map((event) => {
    const fields = { ...(event.assFields ?? {}) },
      styleMap = styleMaps[event.sourceEpisodeOrder]!,
      kind = fields.__kind ?? "Dialogue";
    fields.start = formatAssTime(event.start);
    fields.end = formatAssTime(event.end);
    if (fields.style !== undefined && styleMap.has(fields.style))
      fields.style = styleMap.get(fields.style)!;
    fields.text = rewriteResetStyles(event.text, styleMap);
    return `${kind}: ${eventFormat.map((field) => fields[field.toLowerCase()] ?? "").join(",")}`;
  });
  const first = parsed[0]!;
  return `[Script Info]\nScriptType: v4.00+\n${first.playResX === undefined ? "" : `PlayResX: ${first.playResX}\n`}${first.playResY === undefined ? "" : `PlayResY: ${first.playResY}\n`}${first.scriptInfo.join("\n")}\n\n[V4+ Styles]\nFormat: ${styleFormat.join(", ")}\n${styleLines.join("\n")}\n\n[Events]\nFormat: ${eventFormat.join(", ")}\n${eventLines.join("\n")}\n${[...new Set(parsed.flatMap((item) => item.attachments))].join("\n")}`;
}
