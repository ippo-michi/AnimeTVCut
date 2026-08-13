import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL ?? "http://127.0.0.1:18888";
const originUrl =
  process.env.MEDIAFLOW_TEST_ORIGIN_URL ?? "http://fixture-origin:8090";
const originStatsUrl =
  process.env.MEDIAFLOW_TEST_ORIGIN_STATS_URL ?? "http://127.0.0.1:18090";
const password = "phase2-integration-password";
const sourceToken = "animetvcut-test";
const app = createApp({
  mediaFlow: {
    baseUrl: mediaFlowUrl,
    apiPassword: password,
    requestTimeoutMs: 60_000,
    outputContainer: "mpegts",
  },
});

let baseUrl: string;
let playlistUrl: string;
let playlistText: string;
let duration: number;
let pieces: Array<{
  sourceEpisodeId: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
}>;

async function runMediaTool(
  tool: "ffmpeg" | "ffprobe",
  args: string[],
): Promise<string> {
  const result = await execFileAsync(tool, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout;
}

async function decodeWindow(start: number, seconds: number): Promise<void> {
  const progress = await runMediaTool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    String(start),
    "-i",
    playlistUrl,
    "-t",
    String(seconds),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
    "-progress",
    "pipe:1",
  ]);
  const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
  expect(Number(frames ?? 0)).toBeGreaterThan(0);
  expect(progress).toContain("progress=end");
}

async function requestStats(): Promise<{
  healthRequests: number;
  playlistRequests: number;
  resourceRequests: number;
}> {
  const response = await fetch(`${baseUrl}/api/v1/dev/mediaflow/health`);
  const body = (await response.json()) as {
    configured: boolean;
    reachable: boolean;
    requests: {
      healthRequests: number;
      playlistRequests: number;
      resourceRequests: number;
    };
  };
  expect(body.configured).toBe(true);
  expect(body.reachable).toBe(true);
  return body.requests;
}

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fastify did not expose a TCP test address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/v1/dev/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [1, 2, 3].map((episode) => ({
        kind: "http_file",
        episodeId: `ep${episode}`,
        url: `${originUrl}/redirect/episode${episode}.mkv`,
        headers: { "X-Test-Token": sourceToken },
      })),
      remove: [
        { episodeId: "ep1", start: 24, end: 30.008, type: "ending" },
        { episodeId: "ep2", start: 0, end: 6, type: "opening" },
        { episodeId: "ep2", start: 24, end: 30.008, type: "ending" },
        { episodeId: "ep3", start: 0, end: 6, type: "opening" },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`MediaFlow cut creation failed: ${await response.text()}`);
  }
  const cut = (await response.json()) as {
    duration: number;
    playlistUrl: string;
    pieces: typeof pieces;
  };
  duration = cut.duration;
  pieces = cut.pieces;
  playlistUrl = `${baseUrl}${cut.playlistUrl}`;
  const playlistResponse = await fetch(playlistUrl);
  playlistText = await playlistResponse.text();
});

afterAll(async () => {
  await app.close();
});

describe("real MKV to MediaFlow to AnimeTVCut composition", () => {
  it("creates the intended retained timeline from normalized segment boundaries", () => {
    expect(pieces).toEqual([
      {
        id: "piece-1",
        sourceEpisodeId: "ep1",
        sourceStart: 0,
        sourceEnd: 24,
        outputStart: 0,
        outputEnd: 24,
        kind: "content",
      },
      {
        id: "piece-2",
        sourceEpisodeId: "ep2",
        sourceStart: 6,
        sourceEnd: 24,
        outputStart: 24,
        outputEnd: 42,
        kind: "content",
      },
      {
        id: "piece-3",
        sourceEpisodeId: "ep3",
        sourceStart: 6,
        sourceEnd: 30.008,
        outputStart: 42,
        outputEnd: 66.008,
        kind: "content",
      },
    ]);
  });

  it("emits only opaque seekable MPEG-TS URLs with no secrets", () => {
    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    expect(parsed.segments).toHaveLength(11);
    expect(playlistText).not.toContain("#EXT-X-MAP");
    expect(playlistText.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(playlistText).not.toMatch(
      /MEDIAFLOW|mediaflow|fixture-origin|episode[123]\.mkv|api_password|phase2-integration-password|animetvcut-test/,
    );
    for (const segment of parsed.segments) {
      expect(segment.map).toBeUndefined();
      expect(segment.mediaFormat).toBe("mpegts");
      expect(new URL(segment.absoluteUri).pathname).toMatch(
        /\/segment\/r\d+\.ts$/,
      );
    }
  });

  it("proves cut creation did not eagerly fetch any MediaFlow resources", async () => {
    const before = await requestStats();
    expect(before.playlistRequests).toBe(3);
    expect(before.resourceRequests).toBe(0);

    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    const firstSegment = parsed.segments[0];
    if (firstSegment === undefined) throw new Error("No normalized segment");
    const response = await fetch(firstSegment.absoluteUri);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("video/mp2t");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const after = await requestStats();
    expect(after.resourceRequests).toBe(1);
  });

  it("resolves each debrid-style redirect once and reuses its final CDN URL", async () => {
    const statsResponse = await fetch(`${originStatsUrl}/stats`);
    const stats = (await statsResponse.json()) as {
      redirects: number;
      requests: Array<{ pathname: string }>;
    };
    expect(stats.redirects).toBe(3);
    expect(
      stats.requests.filter(({ pathname }) =>
        pathname.startsWith("/redirect/"),
      ),
    ).toHaveLength(3);
  });

  it("coalesces a failed CDN refresh and retries through the new destination", async () => {
    const failResponse = await fetch(`${originStatsUrl}/cdn/fail-primary`);
    expect(failResponse.status).toBe(200);

    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    const secondSegment = parsed.segments[1];
    if (secondSegment === undefined) throw new Error("No second segment");
    const requests = await Promise.all(
      Array.from({ length: 4 }, async () => fetch(secondSegment.absoluteUri)),
    );
    expect(requests.every((response) => response.status === 200)).toBe(true);
    await Promise.all(requests.map(async (response) => response.arrayBuffer()));

    const statsResponse = await fetch(`${originStatsUrl}/stats`);
    const stats = (await statsResponse.json()) as {
      redirects: number;
      primaryFailures: number;
      requests: Array<{ pathname: string; statusCode: number }>;
    };
    expect(stats.redirects).toBe(4);
    expect(stats.primaryFailures).toBeGreaterThan(0);
    expect(
      stats.requests.some(
        ({ pathname, statusCode }) =>
          pathname.startsWith("/secondary/") && statusCode === 206,
      ),
    ).toBe(true);
  });

  it("reports H.264 video, AAC audio, and the calculated duration", async () => {
    const output = await runMediaTool("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type",
      "-of",
      "json",
      playlistUrl,
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
    expect(Math.abs(Number(probe.format.duration) - duration)).toBeLessThan(1);
    expect(Math.abs(duration - 66.008)).toBeLessThan(0.02);
  });

  it("decodes across both episode boundaries", async () => {
    await decodeWindow(22, 4);
    await decodeWindow(40, 4);
  });

  it("seeks into E2 and E3, then backward into E1", async () => {
    await decodeWindow(30, 1);
    await decodeWindow(50, 1);
    await decodeWindow(10, 1);
  });

  it("decodes the full composition with audio and video", async () => {
    await runMediaTool("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      playlistUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ]);
  });
});
