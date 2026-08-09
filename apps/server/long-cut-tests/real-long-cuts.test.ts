import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import type { SkipSegmentProvider } from "@animetvcut/skip-providers";
import { parseWebVtt } from "@animetvcut/subtitles";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const metadataManifestUrl = process.env.METADATA_STREMIO_TEST_MANIFEST_URL!;
const upstreamManifestUrl = process.env.UPSTREAM_TEST_MANIFEST_URL!;
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL!;
const publicBaseUrl = new URL("http://127.0.0.1:13007/");
let skipRequests = 0;

const skipProvider: SkipSegmentProvider = {
  name: "long-cut-fixed",
  priority: 1,
  supports: () => true,
  getSegments: async () => {
    skipRequests += 1;
    return {
      provider: "long-cut-fixed",
      status: "found",
      warnings: [],
      segments: [
        {
          type: "opening",
          start: 0,
          end: 6,
          provider: "long-cut-fixed",
          automaticRemoval: true,
        },
        {
          type: "ending",
          start: 24,
          end: 30.008,
          provider: "long-cut-fixed",
          automaticRemoval: true,
        },
      ],
    };
  },
};

const app = createApp({
  mediaFlow: {
    baseUrl: mediaFlowUrl,
    apiPassword: "phase5-integration-password",
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
  skipProviders: [skipProvider],
  now: () => Date.parse("2026-01-01T00:00:00Z"),
  subtitles: {
    allowedOrigins: ["http://127.0.0.1:19093"],
    composeFetchConcurrency: 3,
  },
});

interface PublicStream {
  title: string;
  url: string;
  subtitles: Array<{ id: string; url: string; lang: string }>;
  behaviorHints: { bingeGroup: string };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${url} failed: ${response.status} ${body}`,
    );
  return JSON.parse(body) as T;
}

async function media(tool: "ffmpeg" | "ffprobe", args: string[]) {
  return (
    await execFileAsync(tool, args, {
      timeout: 300_000,
      maxBuffer: 20 * 1024 * 1024,
    })
  ).stdout;
}

async function decodeWindow(url: string, start: number, duration = 3) {
  await media("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    String(start),
    "-i",
    url,
    "-t",
    String(duration),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
}

function cutId(url: string): string {
  const match = /\/media\/cut\/([^/]+)\/master\.m3u8$/.exec(url);
  if (match?.[1] === undefined) throw new Error("Missing opaque cut ID");
  return match[1];
}

let metadataOnly: unknown;
let seasonStream: PublicStream;
let completeStream: PublicStream;
let completePlaylist = "";
let completeChapters: {
  duration: number;
  chapters: Array<{ title: string; start: number; sourceEpisodeId: string }>;
};
let english = "";
let japanese = "";
let afterSeason: { playlists: number; resources: number; skips: number };
let afterComplete: { playlists: number; resources: number; skips: number };
let subtitleStatsAfterEnglish: {
  total: number;
  maxActive: number;
  byEpisodeLanguage: Record<string, number>;
};

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: Number(publicBaseUrl.port) });
  const catalog = await json<{
    metas: Array<{ id: string; name: string }>;
  }>(`${publicBaseUrl}catalog/series/animetvcut/search=Opaque.json`);
  const tvMeta = catalog.metas.find((item) => item.name.endsWith("— TV Cut"));
  const seasonMeta = catalog.metas.find((item) =>
    item.name.endsWith("— Season Cut"),
  );
  const seriesMeta = catalog.metas.find((item) =>
    item.name.endsWith("— Complete Cut"),
  );
  if (
    tvMeta === undefined ||
    seasonMeta === undefined ||
    seriesMeta === undefined
  )
    throw new Error("Missing public cut modes");
  await json(
    `${publicBaseUrl}meta/series/${encodeURIComponent(tvMeta.id)}.json`,
  );
  const season = await json<{
    meta: { videos: Array<{ id: string; season: number; title: string }> };
  }>(`${publicBaseUrl}meta/series/${encodeURIComponent(seasonMeta.id)}.json`);
  const complete = await json<{
    meta: { videos: Array<{ id: string; title: string }> };
  }>(`${publicBaseUrl}meta/series/${encodeURIComponent(seriesMeta.id)}.json`);
  const upstreamBefore = await json<{ streamRequests: number }>(
    "http://127.0.0.1:18989/stats",
  );
  const flowBefore = await json<{
    requests: { playlistRequests: number; resourceRequests: number };
  }>(`${publicBaseUrl}api/v1/dev/mediaflow/health`);
  const subtitleBefore = await json<{ total: number }>(
    "http://127.0.0.1:19093/stats",
  );
  metadataOnly = {
    upstreamStreams: upstreamBefore.streamRequests,
    playlists: flowBefore.requests.playlistRequests,
    resources: flowBefore.requests.resourceRequests,
    skips: skipRequests,
    subtitleFiles: subtitleBefore.total,
  };

  const seasonOne = season.meta.videos.find((item) => item.season === 1)!;
  seasonStream = (
    await json<{ streams: PublicStream[] }>(
      `${publicBaseUrl}stream/series/${encodeURIComponent(seasonOne.id)}.json`,
    )
  ).streams[0]!;
  const flowAfterSeason = await json<{
    requests: { playlistRequests: number; resourceRequests: number };
  }>(`${publicBaseUrl}api/v1/dev/mediaflow/health`);
  afterSeason = {
    playlists: flowAfterSeason.requests.playlistRequests,
    resources: flowAfterSeason.requests.resourceRequests,
    skips: skipRequests,
  };

  completeStream = (
    await json<{ streams: PublicStream[] }>(
      `${publicBaseUrl}stream/series/${encodeURIComponent(complete.meta.videos[0]!.id)}.json`,
    )
  ).streams[0]!;
  const flowAfterComplete = await json<{
    requests: { playlistRequests: number; resourceRequests: number };
  }>(`${publicBaseUrl}api/v1/dev/mediaflow/health`);
  afterComplete = {
    playlists: flowAfterComplete.requests.playlistRequests,
    resources: flowAfterComplete.requests.resourceRequests,
    skips: skipRequests,
  };
  completePlaylist = await (await fetch(completeStream.url)).text();
  completeChapters = await json(
    `${publicBaseUrl}media/cut/${cutId(completeStream.url)}/chapters.json`,
  );
  const eng = completeStream.subtitles.find((item) => item.lang === "eng")!;
  const jpn = completeStream.subtitles.find((item) => item.lang === "jpn")!;
  english = await (await fetch(eng.url)).text();
  subtitleStatsAfterEnglish = await json("http://127.0.0.1:19093/stats");
  japanese = await (await fetch(jpn.url)).text();
}, 900_000);

afterAll(async () => app.close());

describe("real 12-episode Season and Complete Cuts", () => {
  it("does metadata-only planning and exposes all modes", () => {
    expect(metadataOnly).toEqual({
      upstreamStreams: 0,
      playlists: 0,
      resources: 0,
      skips: 0,
      subtitleFiles: 0,
    });
  });

  it("prepares each source playlist once and leaves media bytes lazy", () => {
    expect(afterSeason).toEqual({ playlists: 6, resources: 0, skips: 6 });
    expect(afterComplete).toEqual({ playlists: 18, resources: 0, skips: 18 });
  });

  it("selects strict family A for Season 1 and family B for Season 2", async () => {
    const diagnostic = await json<{
      families: Array<{ season: number; method: string; episodeCount: number }>;
    }>(`${publicBaseUrl}api/v1/dev/long-cuts/${cutId(completeStream.url)}`);
    expect(diagnostic.families).toEqual([
      { season: 1, method: "binge_group", episodeCount: 6 },
      { season: 2, method: "binge_group", episodeCount: 6 },
    ]);
    const stats = await json<{ streamByVideoId: Record<string, number> }>(
      "http://127.0.0.1:18989/stats",
    );
    expect(Object.keys(stats.streamByVideoId).sort()).toEqual(
      [
        ...Array.from(
          { length: 6 },
          (_, index) => `fixture:opaque:episode:${index + 1}`,
        ),
        ...Array.from(
          { length: 6 },
          (_, index) => `fixture:opaque:season2:episode:${index + 1}`,
        ),
      ].sort(),
    );
  });

  it("composes one opaque fMP4 manifest with a global opening/ending policy", () => {
    const parsed = parseHlsVodPlaylist(completePlaylist, completeStream.url);
    expect(parsed.segments).toHaveLength(38);
    expect(completePlaylist).toContain("#EXT-X-MAP");
    expect(completePlaylist.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(11);
    expect(completePlaylist).toMatch(/\/segment\/r\d+\.m4s/);
    expect(completePlaylist).not.toMatch(
      /fixture-origin|mediaflow|api_password|phase5-integration-password|subtitle-secret|test-secret/,
    );
  });

  it("derives all chapter starts from the actual retained timeline", () => {
    expect(
      completeChapters.chapters.map((item) => item.title.split(" — ")[0]),
    ).toEqual([
      "S1E1",
      "S1E2",
      "S1E3",
      "S1E4",
      "S1E5",
      "S1E6",
      "S2E1",
      "S2E2",
      "S2E3",
      "S2E4",
      "S2E5",
      "S2E6",
    ]);
    expect(
      completeChapters.chapters.map((item) => Math.round(item.start)),
    ).toEqual([0, 24, 42, 60, 78, 96, 114, 132, 150, 168, 186, 204]);
  });

  it("composes all-episode WebVTT lazily with bounded fetch concurrency", () => {
    const events = parseWebVtt(english, "combined", 0).events;
    const texts = events.map((event) => event.text);
    const text = texts.join("\n");
    expect(text).toContain("E1-OPENING");
    expect(text).toContain("E1-STORY-A");
    expect(text).toContain("S2E1-STORY-A");
    expect(text).toContain("S2E6-ENDING");
    for (const marker of [
      ...Array.from({ length: 6 }, (_, index) => `E${index + 1}-ENDING`),
      ...Array.from({ length: 5 }, (_, index) => `E${index + 2}-OPENING`),
      ...Array.from({ length: 5 }, (_, index) => `S2E${index + 1}-ENDING`),
      ...Array.from({ length: 6 }, (_, index) => `S2E${index + 1}-OPENING`),
    ])
      expect(texts).not.toContain(marker);
    expect(
      events.find((event) => event.text === "S2E1-STORY-A")?.start,
    ).toBeCloseTo(116, 2);
    expect(
      events.find((event) => event.text === "S2E6-ENDING")?.start,
    ).toBeCloseTo(224, 2);
    expect(subtitleStatsAfterEnglish.total).toBe(12);
    expect(subtitleStatsAfterEnglish.maxActive).toBeLessThanOrEqual(3);
    expect(
      Object.keys(subtitleStatsAfterEnglish.byEpisodeLanguage).filter((key) =>
        key.endsWith("-jpn"),
      ),
    ).toHaveLength(0);
  });

  it("keeps 12-episode ASS styles namespaced and libass-valid", async () => {
    expect(japanese).toContain("Style: E1_Default");
    expect(japanese).toContain("Style: E12_Default");
    expect(japanese).toContain("{\\rE7_Sign}S2E1-STORY-JPN");
    const directory = await mkdtemp(
      path.join(tmpdir(), "animetvcut-long-ass-"),
    );
    const file = path.join(directory, "complete.ass");
    try {
      await writeFile(file, japanese);
      await media("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=25:d=228.1",
        "-vf",
        `ass=${file.replace(/\\/g, "/").replace(/:/g, "\\:")}`,
        "-f",
        "null",
        "-",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fully decodes the Complete Cut before random-access checks", async () => {
    await media("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      completeStream.url,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ]);
  }, 320_000);

  it("probes and crosses an episode boundary in the Season Cut", async () => {
    const probe = JSON.parse(
      await media("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type",
        "-of",
        "json",
        seasonStream.url,
      ]),
    ) as {
      streams: Array<{ codec_name: string }>;
      format: { duration: string };
    };
    expect(probe.streams.map((item) => item.codec_name)).toEqual(
      expect.arrayContaining(["h264", "aac"]),
    );
    expect(Number(probe.format.duration)).toBeCloseTo(120, 0);
    await decodeWindow(seasonStream.url, 58);
  }, 320_000);

  it("FFprobes H.264/AAC with the expected long-cut duration", async () => {
    const probe = JSON.parse(
      await media("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type",
        "-of",
        "json",
        completeStream.url,
      ]),
    ) as {
      streams: Array<{ codec_name: string; codec_type: string }>;
      format: { duration: string };
    };
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_name: "h264", codec_type: "video" }),
        expect.objectContaining({ codec_name: "aac", codec_type: "audio" }),
      ]),
    );
    expect(Number(probe.format.duration)).toBeCloseTo(228, 0);
  }, 320_000);

  it("decodes the S1E5/S1E6, S1E6/S2E1, and S2E1/S2E2 boundaries", async () => {
    await decodeWindow(completeStream.url, 94, 41);
  }, 320_000);

  it("seeks into Season 2 and backward into Season 1", async () => {
    await decodeWindow(completeStream.url, 160);
    await decodeWindow(completeStream.url, 10);
  }, 620_000);

  it("keeps Season and Complete cache/binge identities independent", () => {
    expect(seasonStream.behaviorHints.bingeGroup).not.toBe(
      completeStream.behaviorHints.bingeGroup,
    );
    expect(seasonStream.title).toMatch(/Season Cut.*2m/);
    expect(completeStream.title).toMatch(/Complete Cut.*4m/);
  });
});
