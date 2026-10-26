import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { BoundedCache, WorkQueue } from "@animetvcut/core";
import type { HttpMediaSource } from "./hls-source-loader.js";
import type { SubtitleSourceFormat } from "@animetvcut/subtitles";

const exec = promisify(execFile);
const metadataSchema = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        codec_name: z.string().optional(),
        tags: z
          .object({
            language: z.string().optional(),
            title: z.string().optional(),
          })
          .optional(),
        disposition: z
          .object({
            forced: z.number().optional(),
            hearing_impaired: z.number().optional(),
          })
          .optional(),
      }),
    )
    .max(128),
});
export interface EmbeddedSubtitleTrack {
  streamIndex: number;
  lang: string;
  format: SubtitleSourceFormat;
  key: string;
}
export interface EmbeddedSubtitleReader {
  discover(
    source: HttpMediaSource,
    signal?: AbortSignal,
  ): Promise<readonly EmbeddedSubtitleTrack[]>;
  extract(
    source: HttpMediaSource,
    track: Pick<EmbeddedSubtitleTrack, "streamIndex" | "format">,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
}
function inputArgs(source: HttpMediaSource): string[] {
  const url = new URL(source.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("invalid_embedded_source");
  const headers = Object.entries(source.headers ?? {});
  if (
    headers.some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value),
    )
  )
    throw new Error("invalid_embedded_headers");
  return [
    "-protocol_whitelist",
    "http,https,tcp,tls",
    "-rw_timeout",
    "10000000",
    ...(headers.length
      ? [
          "-headers",
          headers.map(([key, value]) => `${key}: ${value}\r\n`).join(""),
        ]
      : []),
  ];
}
/** Selected upstream sources only; never accepts public subtitle URLs or local paths. */
export class EmbeddedSubtitleService implements EmbeddedSubtitleReader {
  private readonly queue = new WorkQueue(2);
  private readonly cache = new BoundedCache<
    string,
    { expiresAt: number; tracks: readonly EmbeddedSubtitleTrack[] }
  >(256);
  public constructor(private readonly maxBytes = 5_242_880) {}
  public async discover(
    source: HttpMediaSource,
    signal?: AbortSignal,
  ): Promise<readonly EmbeddedSubtitleTrack[]> {
    signal?.throwIfAborted();
    const key = JSON.stringify([source.url, source.headers]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached.tracks;
    try {
      const tracks = await this.queue.run(async () => {
        const { stdout } = await exec(
          "ffprobe",
          [
            "-v",
            "error",
            ...inputArgs(source),
            "-select_streams",
            "s",
            "-show_entries",
            "stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired",
            "-of",
            "json",
            source.url,
          ],
          { timeout: 15_000, maxBuffer: 128 * 1024, signal },
        );
        return metadataSchema
          .parse(JSON.parse(stdout))
          .streams.flatMap<EmbeddedSubtitleTrack>((stream) => {
            const format =
              stream.codec_name === "ass" || stream.codec_name === "ssa"
                ? "ass"
                : ["subrip", "webvtt", "mov_text", "text"].includes(
                      stream.codec_name ?? "",
                    )
                  ? "srt"
                  : undefined;
            if (format === undefined) return [];
            const lang =
              (stream.tags?.language ?? "und")
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "")
                .slice(0, 16) || "und";
            // Track order may differ between episodes. Match by language, format and role.
            const title = (stream.tags?.title ?? "")
              .normalize("NFKC")
              .trim()
              .toLowerCase();
            return [
              {
                streamIndex: stream.index,
                lang,
                format,
                key: `${lang}:${format}:${stream.disposition?.forced ?? 0}:${stream.disposition?.hearing_impaired ?? 0}:${title}`,
              },
            ];
          });
      }, signal);
      this.cache.set(key, { expiresAt: Date.now() + 300_000, tracks });
      return tracks;
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }
  public async extract(
    source: HttpMediaSource,
    track: Pick<EmbeddedSubtitleTrack, "streamIndex" | "format">,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(track.streamIndex) ||
      track.streamIndex < 0 ||
      track.streamIndex > 127
    )
      throw new Error("invalid_embedded_track");
    try {
      return await this.queue.run(async () => {
        const format =
          track.format === "ass" || track.format === "ssa" ? "ass" : "srt";
        const { stdout } = await exec(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            ...inputArgs(source),
            "-i",
            source.url,
            "-map",
            `0:${track.streamIndex}`,
            "-vn",
            "-an",
            "-c:s",
            format === "ass" ? "ass" : "srt",
            "-f",
            format,
            "pipe:1",
          ],
          {
            timeout: 60_000,
            maxBuffer: this.maxBytes,
            encoding: "buffer",
            signal,
          },
        );
        // Explicit mapping selects the subtitle stream; do not globally disable subtitles.
        return {
          bytes: new Uint8Array(stdout),
          contentType: format === "ass" ? "text/x-ssa" : "application/x-subrip",
        };
      }, signal);
    } catch {
      signal?.throwIfAborted();
      throw new Error("embedded_subtitle_extraction_failed");
    }
  }
}
