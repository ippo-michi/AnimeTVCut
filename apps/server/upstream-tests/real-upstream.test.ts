import { execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const manifestUrl =
  process.env.UPSTREAM_TEST_MANIFEST_URL ??
  "http://127.0.0.1:18989/stremio/test-user/test-secret/manifest.json";
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL ?? "http://127.0.0.1:18888";
const mediaFlowPassword = "phase3-integration-password";
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
    manifestUrl,
    requestTimeoutMs: 30_000,
    manifestCacheTtlMs: 300_000,
    streamCacheTtlMs: 60_000,
  },
});

let baseUrl: string;
let playlistUrl: string;
let playlistText: string;
let cutBodyText: string;
let cut: {
  duration: number;
  playlistUrl: string;
  pieces: Array<{
    sourceEpisodeId: string;
    sourceStart: number;
    sourceEnd: number;
    outputStart: number;
    outputEnd: number;
  }>;
  selection: {
    familyMethod: string;
    episodes: Array<{ episodeId: string; rank: number; filename: string }>;
    unsupported: { torrent: number; usenet: number; other: number };
  };
};

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
  await runMediaTool("ffmpeg", [
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
  ]);
}

async function addonStats(): Promise<{
  manifestRequests: number;
  streamRequests: number;
  streamByVideoId: Record<string, number>;
}> {
  const response = await fetch("http://127.0.0.1:18989/stats");
  return (await response.json()) as Awaited<ReturnType<typeof addonStats>>;
}

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fastify did not expose a TCP test address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/v1/dev/cuts/from-upstream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      episodes: [1, 2, 3].map((episode) => ({
        episodeId: `ep${episode}`,
        type: "series",
        videoId: `tt1234567:1:${episode}`,
      })),
      remove: [
        { episodeId: "ep1", start: 24, end: 30.008, type: "ending" },
        { episodeId: "ep2", start: 0, end: 6, type: "opening" },
        { episodeId: "ep2", start: 24, end: 30.008, type: "ending" },
        { episodeId: "ep3", start: 0, end: 6, type: "opening" },
      ],
    }),
  });
  cutBodyText = await response.text();
  if (!response.ok) throw new Error(`Upstream cut failed: ${cutBodyText}`);
  cut = JSON.parse(cutBodyText) as typeof cut;
  playlistUrl = `${baseUrl}${cut.playlistUrl}`;
  playlistText = await (await fetch(playlistUrl)).text();
});

afterAll(async () => {
  await app.close();
  logStream.end();
});

describe("real Stremio fixture to MediaFlow to AnimeTVCut composition", () => {
  it("queries three standard stream resources and selects one complete family", async () => {
    const stats = await addonStats();
    expect(stats.manifestRequests).toBe(1);
    expect(stats.streamRequests).toBe(3);
    expect(Object.values(stats.streamByVideoId)).toEqual([1, 1, 1]);
    expect(cut.selection).toEqual({
      familyMethod: "binge_group",
      episodes: [
        {
          episodeId: "ep1",
          rank: 1,
          filename: "[GroupA] Fixture Show - 01.1080p.mkv",
          candidateKind: "url",
        },
        {
          episodeId: "ep2",
          rank: 1,
          filename: "[GroupA] Fixture Show - 02.1080p.mkv",
          candidateKind: "url",
        },
        {
          episodeId: "ep3",
          rank: 0,
          filename: "[GroupA] Fixture Show - 03.1080p.mkv",
          candidateKind: "url",
        },
      ],
      unsupported: { torrent: 2, usenet: 1, other: 1 },
      warnings: [],
    });
  });

  it("propagates proxyHeaders through MediaFlow without exposing secrets", async () => {
    const origin = (await (
      await fetch("http://127.0.0.1:18090/stats")
    ).json()) as { authorized: number; denied: number };
    expect(origin.authorized).toBeGreaterThanOrEqual(3);
    expect(origin.denied).toBe(0);
    const publicData = `${cutBodyText}\n${playlistText}\n${capturedLogs}`;
    expect(publicData).not.toMatch(
      /stremio-upstream-secret|phase3-integration-password|test-secret|fixture-origin|temporary-[123]|api_password|signed-source|Authorization|Cookie/,
    );
  });

  it("keeps normalized MediaFlow resources lazy after upstream resolution", async () => {
    const mediaHealth = await fetch(`${baseUrl}/api/v1/dev/mediaflow/health`);
    const media = (await mediaHealth.json()) as {
      requests: { playlistRequests: number; resourceRequests: number };
    };
    expect(media.requests.playlistRequests).toBe(3);
    expect(media.requests.resourceRequests).toBe(0);

    const upstreamHealth = await fetch(`${baseUrl}/api/v1/dev/upstream/health`);
    const upstream = (await upstreamHealth.json()) as {
      origin: string;
      requests: { manifestRequests: number; streamRequests: number };
    };
    expect(upstream.origin).toBe("http://127.0.0.1:18989");
    expect(upstream.requests).toEqual({
      manifestRequests: 1,
      streamRequests: 3,
    });
    expect(JSON.stringify(upstream)).not.toContain("test-secret");

    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    const firstSegment = parsed.segments[0];
    if (firstSegment === undefined) throw new Error("No normalized segment");
    const segment = await fetch(firstSegment.absoluteUri);
    expect(segment.status).toBe(200);
    expect((await segment.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const after = (await (
      await fetch(`${baseUrl}/api/v1/dev/mediaflow/health`)
    ).json()) as { requests: { resourceRequests: number } };
    expect(after.requests.resourceRequests).toBe(1);
  });

  it("returns the same sanitized selection from the cached resolve endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/v1/dev/upstream/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        episodes: [1, 2, 3].map((episode) => ({
          episodeId: `ep${episode}`,
          type: "series",
          videoId: `tt1234567:1:${episode}`,
        })),
      }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual(cut.selection);
    expect((await addonStats()).streamRequests).toBe(3);
    expect(body).not.toMatch(/https?:|secret|token|header/i);
  });

  it("reports H.264, AAC, and the composed duration through FFprobe", async () => {
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
    expect(Math.abs(Number(probe.format.duration) - cut.duration)).toBeLessThan(
      1,
    );
    expect(Math.abs(cut.duration - 66.008)).toBeLessThan(0.02);
  });

  it("decodes both episode transitions", async () => {
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
