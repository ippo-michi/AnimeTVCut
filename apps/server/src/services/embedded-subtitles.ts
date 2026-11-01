import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
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
    keepAlive?: () => boolean,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  sample?(
    source: HttpMediaSource,
    track: Pick<EmbeddedSubtitleTrack, "streamIndex" | "format">,
    window: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
}
type EmbeddedResult = { bytes: Uint8Array; contentType: string };
type SharedExtraction = {
  controller: AbortController;
  promise: Promise<Map<number, EmbeddedResult>>;
  waiters: number;
  settled: boolean;
  keepAlive: Set<() => boolean>;
  idleTimer?: NodeJS.Timeout;
};
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
  private readonly probeQueue = new WorkQueue(2);
  private readonly sampleQueue = new WorkQueue(3);
  private readonly cache = new BoundedCache<
    string,
    { expiresAt: number; tracks: readonly EmbeddedSubtitleTrack[] }
  >(256);
  private readonly extracted = new BoundedCache<
    string,
    { expiresAt: number; size: number; tracks: Map<number, EmbeddedResult> }
  >(32);
  private readonly inFlight = new Map<string, SharedExtraction>();
  private pendingSamples = 0;
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
      const tracks = await this.probeQueue.run(async () => {
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
    keepAlive?: () => boolean,
  ): Promise<EmbeddedResult> {
    if (
      !Number.isSafeInteger(track.streamIndex) ||
      track.streamIndex < 0 ||
      track.streamIndex > 127
    )
      throw new Error("invalid_embedded_track");
    signal?.throwIfAborted();
    const key = JSON.stringify([source.url, source.headers]);
    const cached = this.extracted.get(key)?.tracks.get(track.streamIndex);
    if (cached) return cached;
    const known =
      this.cache.get(key)?.tracks ?? (await this.discover(source, signal));
    signal?.throwIfAborted();
    let shared = this.inFlight.get(key);
    if (!shared) {
      const tracks = [
        track,
        ...known.filter((item) => item.streamIndex !== track.streamIndex),
      ].slice(0, 16);
      const controller = new AbortController();
      const current: SharedExtraction = {
        controller,
        waiters: 0,
        settled: false,
        keepAlive: new Set(),
        promise: undefined as unknown as Promise<Map<number, EmbeddedResult>>,
      };
      current.promise = this.queue
        .run(async () => {
          try {
            // Let the player's simultaneous Japanese request start its short
            // reference samples before large background track reads compete for bandwidth.
            await delay(1_000, undefined, { signal: controller.signal });
            const deadline = Date.now() + 25_000;
            while (this.pendingSamples > 0 && Date.now() < deadline)
              await delay(100, undefined, { signal: controller.signal });
            return await this.extractStreams(source, tracks, controller.signal);
          } catch (error) {
            controller.signal.throwIfAborted();
            if (
              tracks.length > 1 &&
              error instanceof Error &&
              error.message === "embedded_subtitle_batch_failed"
            )
              return this.extractStreams(source, [track], controller.signal);
            throw error;
          }
        }, controller.signal)
        .then((results) => {
          const size = [...results.values()].reduce(
            (sum, item) => sum + item.bytes.byteLength,
            0,
          );
          const prior = this.extracted.get(key);
          const merged = new Map([...(prior?.tracks ?? []), ...results]);
          const mergedSize = [...merged.values()].reduce(
            (sum, item) => sum + item.bytes.byteLength,
            0,
          );
          if (size <= 32 * 1024 * 1024 && mergedSize <= 32 * 1024 * 1024) {
            this.extracted.delete(key);
            while (
              [...this.extracted.values()].reduce(
                (sum, item) => sum + item.size,
                0,
              ) +
                mergedSize >
              32 * 1024 * 1024
            ) {
              const oldest = this.extracted.keys().next().value;
              if (oldest === undefined) break;
              this.extracted.delete(oldest);
            }
            this.extracted.set(key, {
              expiresAt: Date.now() + 300_000,
              tracks: merged,
              size: mergedSize,
            });
          }
          return results;
        })
        .finally(() => {
          current.settled = true;
          if (current.idleTimer) clearInterval(current.idleTimer);
          if (this.inFlight.get(key) === current) this.inFlight.delete(key);
        });
      this.inFlight.set(key, current);
      shared = current;
    }
    const result = await this.waitForExtraction(shared, signal, keepAlive);
    const item =
      result.get(track.streamIndex) ??
      this.extracted.get(key)?.tracks.get(track.streamIndex);
    if (item) return item;
    return this.extract(source, track, signal, keepAlive);
  }

  private waitForExtraction(
    shared: SharedExtraction,
    signal?: AbortSignal,
    keepAlive?: () => boolean,
  ): Promise<Map<number, EmbeddedResult>> {
    shared.waiters++;
    if (keepAlive) shared.keepAlive.add(keepAlive);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (
        result: { value: Map<number, EmbeddedResult> } | { error: unknown },
      ) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", cancel);
        shared.waiters--;
        if (shared.waiters === 0 && !shared.settled) {
          const stillWatching = () =>
            [...shared.keepAlive].some((check) => {
              try {
                return check();
              } catch {
                return false;
              }
            });
          if (!stillWatching()) shared.controller.abort();
          else if (!shared.idleTimer) {
            shared.idleTimer = setInterval(() => {
              if (shared.waiters === 0 && !stillWatching())
                shared.controller.abort();
            }, 5_000);
            shared.idleTimer.unref();
          }
        }
        if ("error" in result)
          reject(
            result.error instanceof Error
              ? result.error
              : new Error("embedded_subtitle_extraction_failed"),
          );
        else resolve(result.value);
      };
      const cancel = () =>
        finish({ error: signal?.reason ?? new Error("cancelled") });
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      void shared.promise.then(
        (value) => finish({ value }),
        () =>
          finish({ error: new Error("embedded_subtitle_extraction_failed") }),
      );
    });
  }

  private async extractStreams(
    source: HttpMediaSource,
    tracks: readonly Pick<EmbeddedSubtitleTrack, "streamIndex" | "format">[],
    signal: AbortSignal,
  ): Promise<Map<number, EmbeddedResult>> {
    const args = [
      "-nostdin",
      "-v",
      "error",
      ...inputArgs(source),
      "-i",
      source.url,
    ];
    tracks.forEach((track, index) => {
      const format =
        track.format === "ass" || track.format === "ssa" ? "ass" : "srt";
      args.push(
        "-map",
        `0:${track.streamIndex}`,
        "-vn",
        "-an",
        "-c:s",
        format,
        "-f",
        format,
        `pipe:${index + 3}`,
      );
    });
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const process = spawn("ffmpeg", args, {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
          ...tracks.map(() => "pipe" as const),
        ],
      });
      const chunks = tracks.map(() => [] as Buffer[]),
        sizes = tracks.map(() => 0);
      let total = 0,
        failed = false;
      const stop = () => {
        failed = true;
        process.kill("SIGKILL");
      };
      const timeout = setTimeout(stop, 180_000);
      signal.addEventListener("abort", stop, { once: true });
      tracks.forEach((_, index) =>
        process.stdio[index + 3]!.on("data", (chunk: Buffer) => {
          total += chunk.length;
          sizes[index] = sizes[index]! + chunk.length;
          if (sizes[index] > this.maxBytes || total > 16 * 1024 * 1024) stop();
          else chunks[index]!.push(chunk);
        }),
      );
      process.once("error", () => {
        failed = true;
      });
      process.once("close", (code) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", stop);
        if (failed || code !== 0) {
          reject(
            new Error(
              failed
                ? "embedded_subtitle_extraction_failed"
                : "embedded_subtitle_batch_failed",
            ),
          );
          return;
        }
        resolve(
          new Map(
            tracks.map((track, index) => [
              track.streamIndex,
              {
                bytes: new Uint8Array(Buffer.concat(chunks[index]!)),
                contentType:
                  track.format === "ass" || track.format === "ssa"
                    ? "text/x-ssa"
                    : "application/x-subrip",
              },
            ]),
          ),
        );
      });
    });
  }

  public async sample(
    source: HttpMediaSource,
    track: Pick<EmbeddedSubtitleTrack, "streamIndex" | "format">,
    window: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (
      !Number.isSafeInteger(track.streamIndex) ||
      track.streamIndex < 0 ||
      track.streamIndex > 127 ||
      !Number.isFinite(window.start) ||
      !Number.isFinite(window.end) ||
      window.start < 0 ||
      window.end <= window.start ||
      window.end - window.start > 120
    )
      throw new Error("invalid_embedded_sample");
    signal?.throwIfAborted();
    const cached = this.extracted
      .get(JSON.stringify([source.url, source.headers]))
      ?.tracks.get(track.streamIndex);
    if (cached) return cached;
    const format =
      track.format === "ass" || track.format === "ssa" ? "ass" : "srt";
    this.pendingSamples++;
    try {
      return await this.sampleQueue.run(async () => {
        const { stdout } = await exec(
          "ffmpeg",
          [
            "-nostdin",
            "-v",
            "error",
            ...inputArgs(source),
            "-ss",
            String(window.start),
            "-copyts",
            "-start_at_zero",
            "-i",
            source.url,
            "-to",
            String(window.end),
            "-map",
            `0:${track.streamIndex}`,
            "-vn",
            "-an",
            "-c:s",
            format,
            "-f",
            format,
            "pipe:1",
          ],
          {
            timeout: 20_000,
            maxBuffer: this.maxBytes,
            encoding: "buffer",
            signal,
          },
        );
        return {
          bytes: new Uint8Array(stdout),
          contentType: format === "ass" ? "text/x-ssa" : "application/x-subrip",
        };
      }, signal);
    } catch {
      signal?.throwIfAborted();
      throw new Error("embedded_subtitle_sample_failed");
    } finally {
      this.pendingSamples--;
    }
  }
}
