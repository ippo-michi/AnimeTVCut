import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import type { SkipSegmentProvider } from "@animetvcut/skip-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const metadataManifestUrl =
  process.env.METADATA_STREMIO_TEST_MANIFEST_URL ??
  "http://127.0.0.1:19092/metadata/test-user/metadata-secret/manifest.json";
const upstreamManifestUrl =
  process.env.UPSTREAM_TEST_MANIFEST_URL ??
  "http://127.0.0.1:18989/stremio/test-user/test-secret/manifest.json";
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL ?? "http://127.0.0.1:18888";
const publicBaseUrl = new URL("http://127.0.0.1:13005/");
const mediaFlowPassword = "phase5-integration-password";
let skipRequests = 0;

const fixedSkipProvider: SkipSegmentProvider = {
  name: "phase5-fixed",
  priority: 1,
  supports: () => true,
  getSegments: async () => {
    skipRequests += 1;
    return {
      provider: "phase5-fixed",
      status: "found",
      warnings: [],
      segments: [
        {
          type: "opening",
          start: 0,
          end: 6,
          provider: "phase5-fixed",
          automaticRemoval: true,
        },
        {
          type: "ending",
          start: 24,
          end: 30.008,
          provider: "phase5-fixed",
          automaticRemoval: true,
        },
      ],
    };
  },
};

const logStream = new PassThrough();
let capturedLogs = "";
logStream.on("data", (chunk: Buffer) => {
  capturedLogs += chunk.toString("utf8");
});

const app = createApp({
  logger: { level: "info", stream: logStream },
  mediaFlow: {
    baseUrl: mediaFlowUrl,
    apiPassword: mediaFlowPassword,
    requestTimeoutMs: 60_000,
  },
  upstreamStremio: {
    manifestUrl: upstreamManifestUrl,
    requestTimeoutMs: 30_000,
    manifestCacheTtlMs: 300_000,
    streamCacheTtlMs: 300_000,
  },
  metadataStremio: {
    manifestUrl: metadataManifestUrl,
    requestTimeoutMs: 30_000,
    manifestCacheTtlMs: 300_000,
    catalogCacheTtlMs: 300_000,
    metaCacheTtlMs: 300_000,
  },
  publicBaseUrl,
  skipProviders: [fixedSkipProvider],
  now: () => Date.parse("2026-01-01T00:00:00Z"),
  subtitles: { allowedOrigins: ["http://127.0.0.1:19093"] },
});

interface PublicVideo {
  id: string;
  season: number;
  episode: number;
  title: string;
}

interface PublicStream {
  name: string;
  url: string;
  subtitles: Array<{ id: string; url: string; lang: string }>;
  behaviorHints: { bingeGroup: string; notWebReady: boolean };
}

let catalogText = "";
let metaText = "";
let partOneStreamText = "";
let partTwoStreamText = "";
let videos: PublicVideo[] = [];
let partOne: PublicStream;
let partTwo: PublicStream;
let partOnePlaylist = "";
let partTwoPlaylist = "";
let partOneSegments: {
  version: number;
  duration: number;
  segments: Array<{ type: string; start: number; end: number; reason: string }>;
};
let metadataOnlyStats: {
  upstreamStreamRequests: number;
  mediaFlowPlaylistRequests: number;
  skipRequests: number;
};
let partOnePreparationStats: {
  upstreamStreamRequests: number;
  mediaFlowPlaylistRequests: number;
  mediaFlowResourceRequests: number;
  skipRequests: number;
};
let preparedResourceRequests = -1;
let subtitleStatsAfterStream: {
  total: number;
  byEpisodeLanguage: Record<string, number>;
};
let upstreamSubtitleRequestsAfterStream = -1;
let englishText = "";
let japaneseText = "";
let partTwoEnglishText = "";
let englishRequestsAfterFirst = -1;
let englishRequestsAfterSecond = -1;

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok)
    throw new Error(`GET ${url} failed: ${response.status} ${body}`);
  return JSON.parse(body) as T;
}

function cutId(url: string): string {
  const match = /\/media\/cut\/([^/]+)\/master\.m3u8$/.exec(url);
  if (match?.[1] === undefined) throw new Error("Missing opaque cut ID");
  return match[1];
}

async function runMediaTool(
  tool: "ffmpeg" | "ffprobe",
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await execFileAsync(tool, args, {
    cwd,
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

async function decodeWindow(
  url: string,
  start: number,
  seconds: number,
): Promise<void> {
  await runMediaTool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    String(start),
    "-i",
    url,
    "-t",
    String(seconds),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
}

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: Number(publicBaseUrl.port) });

  const catalogResponse = await fetch(
    `${publicBaseUrl}catalog/series/animetvcut/search=Opaque.json`,
  );
  catalogText = await catalogResponse.text();
  if (!catalogResponse.ok) throw new Error(`Catalog failed: ${catalogText}`);
  const catalog = JSON.parse(catalogText) as { metas: Array<{ id: string }> };
  const virtualMetaId = catalog.metas[0]?.id;
  if (virtualMetaId === undefined) throw new Error("No opaque catalog result");

  const metaResponse = await fetch(
    `${publicBaseUrl}meta/series/${encodeURIComponent(virtualMetaId)}.json`,
  );
  metaText = await metaResponse.text();
  if (!metaResponse.ok) throw new Error(`Meta failed: ${metaText}`);
  videos = (JSON.parse(metaText) as { meta: { videos: PublicVideo[] } }).meta
    .videos;

  const upstreamStats = await json<{ streamRequests: number }>(
    "http://127.0.0.1:18989/stats",
  );
  const mediaFlowHealth = await json<{
    requests: { playlistRequests: number };
  }>(`${publicBaseUrl}api/v1/dev/mediaflow/health`);
  metadataOnlyStats = {
    upstreamStreamRequests: upstreamStats.streamRequests,
    mediaFlowPlaylistRequests: mediaFlowHealth.requests.playlistRequests,
    skipRequests,
  };

  const firstResponse = await fetch(
    `${publicBaseUrl}stream/series/${encodeURIComponent(videos[0]!.id)}.json`,
  );
  partOneStreamText = await firstResponse.text();
  if (!firstResponse.ok)
    throw new Error(`Part 1 stream failed: ${partOneStreamText}`);
  partOne = (JSON.parse(partOneStreamText) as { streams: PublicStream[] })
    .streams[0]!;
  partOnePlaylist = await (await fetch(partOne.url)).text();
  partOneSegments = await json(
    `${publicBaseUrl}media/cut/${cutId(partOne.url)}/segments.json`,
  );
  const afterPartOneUpstream = await json<{ streamRequests: number }>(
    "http://127.0.0.1:18989/stats",
  );
  const afterPartOneMediaFlow = await json<{
    requests: { playlistRequests: number; resourceRequests: number };
  }>(`${publicBaseUrl}api/v1/dev/mediaflow/health`);
  partOnePreparationStats = {
    upstreamStreamRequests: afterPartOneUpstream.streamRequests,
    mediaFlowPlaylistRequests: afterPartOneMediaFlow.requests.playlistRequests,
    mediaFlowResourceRequests: afterPartOneMediaFlow.requests.resourceRequests,
    skipRequests,
  };

  const secondResponse = await fetch(
    `${publicBaseUrl}stream/series/${encodeURIComponent(videos[1]!.id)}.json`,
  );
  partTwoStreamText = await secondResponse.text();
  if (!secondResponse.ok)
    throw new Error(`Part 2 stream failed: ${partTwoStreamText}`);
  partTwo = (JSON.parse(partTwoStreamText) as { streams: PublicStream[] })
    .streams[0]!;
  partTwoPlaylist = await (await fetch(partTwo.url)).text();
  preparedResourceRequests = (
    await json<{ requests: { resourceRequests: number } }>(
      `${publicBaseUrl}api/v1/dev/mediaflow/health`,
    )
  ).requests.resourceRequests;
  subtitleStatsAfterStream = await json("http://127.0.0.1:19093/stats");
  upstreamSubtitleRequestsAfterStream = (
    await json<{ subtitleRequests: number }>("http://127.0.0.1:18989/stats")
  ).subtitleRequests;
  const english = partOne.subtitles.find((item) => item.lang === "eng")!;
  const japanese = partOne.subtitles.find((item) => item.lang === "jpn")!;
  const [englishFirst, englishConcurrent] = await Promise.all([
    fetch(english.url),
    fetch(english.url),
  ]);
  englishText = await englishFirst.text();
  expect(englishConcurrent.ok).toBe(true);
  englishRequestsAfterFirst = (
    await json<{ total: number }>("http://127.0.0.1:19093/stats")
  ).total;
  expect((await fetch(english.url)).ok).toBe(true);
  englishRequestsAfterSecond = (
    await json<{ total: number }>("http://127.0.0.1:19093/stats")
  ).total;
  japaneseText = await (await fetch(japanese.url)).text();
  partTwoEnglishText = await (
    await fetch(partTwo.subtitles.find((item) => item.lang === "eng")!.url)
  ).text();
});

afterAll(async () => {
  await app.close();
  logStream.end();
});

describe("real metadata addon to grouped Stremio TV Cuts", () => {
  it("discovers one configured search catalog and emits stable parts for both seasons", async () => {
    expect(videos).toEqual([
      expect.objectContaining({
        season: 1,
        episode: 1,
        title: expect.stringContaining("Episodes 1–3"),
      }),
      expect.objectContaining({
        season: 1,
        episode: 2,
        title: expect.stringContaining("Episodes 4–6"),
      }),
      expect.objectContaining({
        season: 2,
        episode: 1,
        title: expect.stringContaining("Episodes 1–3"),
      }),
      expect.objectContaining({
        season: 2,
        episode: 2,
        title: expect.stringContaining("Episodes 4–6"),
      }),
    ]);
    const health = await json<{
      configured: boolean;
      reachable: boolean;
      catalogId: string;
      origin: string;
    }>(`${publicBaseUrl}api/v1/dev/metadata/health`);
    expect(health).toEqual(
      expect.objectContaining({
        configured: true,
        reachable: true,
        catalogId: "fixture-series-primary",
        origin: "http://127.0.0.1:19092",
      }),
    );
  });

  it("does no stream resolution, skip lookup, or normalization for catalog/meta", () => {
    expect(metadataOnlyStats).toEqual({
      upstreamStreamRequests: 0,
      mediaFlowPlaylistRequests: 0,
      skipRequests: 0,
    });
  });

  it("does zero subtitle work for metadata pages and only metadata discovery during stream creation", () => {
    expect(subtitleStatsAfterStream.total).toBe(0);
    expect(upstreamSubtitleRequestsAfterStream).toBe(6);
  });

  it("uses exact opaque episode IDs only when each selected part is streamed", async () => {
    expect(partOnePreparationStats).toEqual({
      upstreamStreamRequests: 3,
      mediaFlowPlaylistRequests: 3,
      mediaFlowResourceRequests: 0,
      skipRequests: 3,
    });
    const stats = await json<{
      streamRequests: number;
      streamByVideoId: Record<string, number>;
    }>("http://127.0.0.1:18989/stats");
    expect(stats.streamRequests).toBe(6);
    expect(Object.keys(stats.streamByVideoId).sort()).toEqual(
      Array.from(
        { length: 6 },
        (_, index) => `fixture:opaque:episode:${index + 1}`,
      ),
    );
    expect(skipRequests).toBe(6);
  });

  it("keeps MediaFlow maps and segments lazy after both parts are prepared", () => {
    expect(preparedResourceRequests).toBe(0);
  });

  it("publishes final-output TV Cut skip controls without changing Stremio fields", () => {
    expect(partOneSegments).toMatchObject({ version: 1 });
    expect(partOneSegments.duration).toBeCloseTo(66.008, 2);
    expect(partOneSegments.segments).toEqual([
      expect.objectContaining({
        type: "intro",
        start: 0,
        end: 6,
        reason: "policy_kept",
      }),
      expect.objectContaining({
        type: "outro",
        start: 60,
        end: 66.008,
        reason: "policy_kept",
      }),
    ]);
    expect(JSON.parse(partOneStreamText).streams[0]).not.toHaveProperty(
      "skipSegments",
    );
  });

  it("emits opaque fMP4 HLS and leaks no internal metadata or transport secrets", () => {
    expect(
      parseHlsVodPlaylist(partOnePlaylist, partOne.url).segments.length,
    ).toBeGreaterThan(0);
    const combined = [
      catalogText,
      metaText,
      partOneStreamText,
      partTwoStreamText,
      partOnePlaylist,
      partTwoPlaylist,
      JSON.stringify(partOneSegments),
      capturedLogs,
    ].join("\n");
    expect(partOnePlaylist).toContain("#EXT-X-MAP");
    expect(partOnePlaylist).toMatch(/\/media\/cut\/[^/]+\/segment\/r\d+\.mp4/);
    expect(partOnePlaylist).toMatch(/\/media\/cut\/[^/]+\/segment\/r\d+\.m4s/);
    expect(combined).not.toMatch(
      /metadata-secret|test-secret|phase5-integration-password|api_password|fixture-origin|temporary-[1-6]|fixture:opaque:episode|subtitle-secret|subtitle-resource-secret|X-Test-Token|Authorization|Cookie/,
    );
  });

  it("publishes only opaque AnimeTVCut URLs for all complete subtitle families", () => {
    expect(partOne.subtitles.map((item) => item.lang).sort()).toEqual([
      "eng",
      "fra",
      "jpn",
    ]);
    for (const subtitle of partOne.subtitles) {
      expect(subtitle.url).toMatch(
        /^http:\/\/127\.0\.0\.1:13005\/media\/cut\/[^/]+\/subtitle\/sub[\w-]+\.(?:vtt|ass)$/,
      );
      expect(subtitle.id).toMatch(/^atc-sub/);
    }
    expect(partOne.behaviorHints.notWebReady).toBe(true);
  });

  it("maps English cues to the actual applied timeline", () => {
    expect(englishText).toContain("00:00:02.000 --> 00:00:03.000\nE1-OPENING");
    expect(englishText).toContain("00:00:26.000 --> 00:00:28.000\nE2-STORY-A");
    expect(englishText).toContain("00:01:02.000 --> 00:01:04.000\nE3-ENDING");
    expect(englishText).toMatch(
      /E1-STORY-A[\s\S]*E1-STORY-B[\s\S]*E2-STORY-A[\s\S]*E2-STORY-B[\s\S]*E3-STORY-A[\s\S]*E3-STORY-B/,
    );
    expect(englishText).not.toMatch(
      /E1-ENDING|E2-OPENING|E2-ENDING|E3-OPENING/,
    );
  });

  it("fetches tracks independently and caches generated bytes", async () => {
    expect(englishRequestsAfterFirst).toBe(3);
    expect(englishRequestsAfterSecond).toBe(3);
    const stats = await json<{ byEpisodeLanguage: Record<string, number> }>(
      "http://127.0.0.1:19093/stats",
    );
    expect(
      ["e1-eng", "e2-eng", "e3-eng"].map((key) => stats.byEpisodeLanguage[key]),
    ).toEqual([1, 1, 1]);
    expect(
      ["e1-jpn", "e2-jpn", "e3-jpn"].map((key) => stats.byEpisodeLanguage[key]),
    ).toEqual([1, 1, 1]);
    expect(stats.byEpisodeLanguage["e1-fra"]).toBeUndefined();
  });

  it("composes namespaced ASS accepted by FFmpeg/libass", async () => {
    expect(japaneseText).toContain("Style: E1_Default");
    expect(japaneseText).toContain("Style: E2_Default");
    expect(japaneseText).toContain("{\\rE2_Sign}E2-STORY-JPN");
    expect(japaneseText).not.toMatch(/E1-ED-JPN|E2-OP-JPN|E2-ED-JPN|E3-OP-JPN/);
    const directory = await mkdtemp(path.join(tmpdir(), "animetvcut-ass-"));
    const file = path.join(directory, "composed.ass");
    try {
      await writeFile(file, japaneseText);
      await runMediaTool(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=320x180:r=25:d=66.1",
          "-vf",
          "ass=filename=composed.ass",
          "-f",
          "null",
          "-",
        ],
        directory,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps Part 2 subtitles isolated to E4-E6 and its own cut", () => {
    expect(partTwoEnglishText).toMatch(
      /E4-OPENING[\s\S]*E4-STORY[\s\S]*E5-STORY[\s\S]*E6-STORY[\s\S]*E6-ENDING/,
    );
    expect(partTwoEnglishText).not.toMatch(/E[1-3]-/);
    expect(partTwo.subtitles[0]?.url).not.toBe(partOne.subtitles[0]?.url);
  });

  it("reuses a stable binge group and cached cut for the same virtual part", async () => {
    expect(partOne.behaviorHints.bingeGroup).toBe(
      partTwo.behaviorHints.bingeGroup,
    );
    const before = await json<{ streamRequests: number }>(
      "http://127.0.0.1:18989/stats",
    );
    const cached = await json<{ streams: PublicStream[] }>(
      `${publicBaseUrl}stream/series/${encodeURIComponent(videos[0]!.id)}.json`,
    );
    const after = await json<{ streamRequests: number }>(
      "http://127.0.0.1:18989/stats",
    );
    expect(cached.streams[0]?.url).toBe(partOne.url);
    expect(after.streamRequests).toBe(before.streamRequests);
  });

  it("FFprobes both parts as H.264/AAC with the expected duration", async () => {
    for (const stream of [partOne, partTwo]) {
      const output = await runMediaTool("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type",
        "-of",
        "json",
        stream.url,
      ]);
      const probe = JSON.parse(output) as {
        streams: Array<{ codec_name: string; codec_type: string }>;
        format: { duration: string };
      };
      expect(probe.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ codec_name: "h264", codec_type: "video" }),
          expect.objectContaining({ codec_name: "aac", codec_type: "audio" }),
        ]),
      );
      expect(Math.abs(Number(probe.format.duration) - 66.008)).toBeLessThan(
        0.1,
      );
    }
  });

  it("fully decodes Part 1 and crosses both boundaries", async () => {
    await runMediaTool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      partOne.url,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ]);
    await decodeWindow(partOne.url, 22, 4);
    await decodeWindow(partOne.url, 40, 4);
  });

  it("seeks across Part 2 boundaries and backward into its first episode", async () => {
    await decodeWindow(partTwo.url, 22, 4);
    await decodeWindow(partTwo.url, 40, 4);
    await decodeWindow(partTwo.url, 50, 1);
    await decodeWindow(partTwo.url, 10, 1);
  });
});
