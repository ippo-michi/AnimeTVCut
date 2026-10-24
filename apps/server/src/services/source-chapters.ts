import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";
import { BoundedCache, WorkQueue } from "@animetvcut/core";
import type { SkipSegment } from "@animetvcut/skip-providers";

import type { HttpMediaSource } from "./hls-source-loader.js";

const execFileAsync = promisify(execFile);
const chapterSchema = z.object({
  chapters: z
    .array(
      z.object({
        start_time: z.string(),
        end_time: z.string().optional(),
        tags: z.object({ title: z.string() }).optional(),
      }),
    )
    .max(1000),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export interface SourceChapter {
  start: number;
  end: number;
  title: string;
}

export interface SourceChapterReader {
  read(
    source: HttpMediaSource,
    signal?: AbortSignal,
  ): Promise<readonly SourceChapter[]>;
}

function chapterType(title: string): "opening" | "ending" | undefined {
  // "Intro", "Outro", and "Credits" can contain story. Only explicit
  // theme labels are evidence for an automatic cut.
  const label = title.normalize("NFKC").trim();
  if (/^(?:op|opening)(?:\s*(?:\d+|theme|credits|animation))?$/i.test(label))
    return "opening";
  if (/^(?:ed|ending)(?:\s*(?:\d+|theme|credits|animation))?$/i.test(label))
    return "ending";
  return undefined;
}

export function chapterSkipSegments(
  chapters: readonly SourceChapter[],
  durationSeconds: number,
): SkipSegment[] {
  return chapters.flatMap((chapter) => {
    const type = chapterType(chapter.title);
    const end = Math.min(chapter.end, durationSeconds);
    if (
      type === undefined ||
      !Number.isFinite(chapter.start) ||
      !Number.isFinite(chapter.end) ||
      chapter.start < 0 ||
      chapter.end > durationSeconds + 0.5 ||
      end - chapter.start < 20 ||
      end - chapter.start > 180
    )
      return [];
    return [
      {
        type,
        start: chapter.start,
        end,
        provider: "source-chapters",
        sourceType: chapter.title,
        automaticRemoval: true,
      },
    ];
  });
}

export function parseSourceChapters(body: unknown): SourceChapter[] {
  const parsed = chapterSchema.parse(body);
  const duration = Number(parsed.format?.duration);
  return parsed.chapters.flatMap((chapter, index) => {
    const start = Number(chapter.start_time);
    const next = parsed.chapters[index + 1];
    const end = Number(chapter.end_time ?? next?.start_time ?? duration);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      (Number.isFinite(duration) && end > duration + 0.5)
    )
      return [];
    return [{ start, end, title: chapter.tags?.title ?? "" }];
  });
}

export class SourceChapterService implements SourceChapterReader {
  private readonly probes: WorkQueue;

  public constructor(concurrency = 2) {
    this.probes = new WorkQueue(concurrency);
  }
  private readonly cache = new BoundedCache<
    string,
    { expiresAt: number; chapters: readonly SourceChapter[] }
  >(256);
  private readonly pending = new Map<
    string,
    Promise<readonly SourceChapter[]>
  >();

  public async read(
    source: HttpMediaSource,
    signal?: AbortSignal,
  ): Promise<readonly SourceChapter[]> {
    signal?.throwIfAborted();
    const url = new URL(source.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return [];
    const key = JSON.stringify([source.url, source.headers]);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now())
      return cached.chapters;
    // A probe belongs to its caller's cancellation scope. Do not share aborted
    // work between separate requests.
    if (signal === undefined) {
      const pending = this.pending.get(key);
      if (pending !== undefined) return pending;
    }
    const probe = this.probes.run(() => this.probe(source, signal), signal);
    if (signal === undefined) this.pending.set(key, probe);
    try {
      const chapters = await probe;
      this.cache.set(key, {
        expiresAt:
          Date.now() + (chapters.length > 0 ? 6 * 60 * 60_000 : 60_000),
        chapters,
      });
      return chapters;
    } finally {
      if (this.pending.get(key) === probe) this.pending.delete(key);
    }
  }

  private async probe(
    source: HttpMediaSource,
    signal?: AbortSignal,
  ): Promise<readonly SourceChapter[]> {
    const args = [
      "-v",
      "error",
      "-rw_timeout",
      "10000000",
      "-analyzeduration",
      "0",
      "-probesize",
      "32768",
      "-show_chapters",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
    ];
    const headers = Object.entries(source.headers ?? {});
    if (
      headers.some(
        ([key, value]) =>
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value),
      )
    )
      return [];
    if (headers.length > 0)
      args.push(
        "-headers",
        headers.map(([key, value]) => `${key}: ${value}\r\n`).join(""),
      );
    args.push(source.url);
    try {
      const { stdout } = await execFileAsync("ffprobe", args, {
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        signal,
      });
      return parseSourceChapters(JSON.parse(stdout) as unknown);
    } catch {
      signal?.throwIfAborted();
      // Never expose process errors: they contain the signed source URL.
      return [];
    }
  }
}
