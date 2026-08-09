import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type SkipProviderResult,
  type SkipSegmentProvider,
} from "@animetvcut/skip-providers";
import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const manifestUrl =
  process.env.UPSTREAM_TEST_MANIFEST_URL ??
  "http://127.0.0.1:18989/stremio/test-user/test-secret/manifest.json";
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL ?? "http://127.0.0.1:18888";
const requestedDurations: number[] = [];

const fixtureSkipProvider: SkipSegmentProvider = {
  name: "fixture-skip",
  priority: 1,
  supports: (identity) => identity.imdb !== undefined,
  getSegments: async (request): Promise<SkipProviderResult> => {
    requestedDurations.push(request.durationSeconds);
    return {
      provider: "fixture-skip",
      status: "found",
      warnings: [],
      segments: [
        {
          type: "opening",
          start: 0,
          end: 6,
          provider: "fixture-skip",
          automaticRemoval: true,
        },
        {
          type: "ending",
          start: 24,
          end: request.durationSeconds,
          reportedEnd: 30,
          provider: "fixture-skip",
          automaticRemoval: true,
        },
      ],
    };
  },
};

const app = createApp({
  mediaFlow: {
    baseUrl: mediaFlowUrl,
    apiPassword: "phase3-integration-password",
    requestTimeoutMs: 60_000,
  },
  upstreamStremio: {
    manifestUrl,
    requestTimeoutMs: 30_000,
    manifestCacheTtlMs: 300_000,
    streamCacheTtlMs: 60_000,
  },
  skipProviders: [fixtureSkipProvider],
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
  appliedCuts: Array<{
    episodeId: string;
    type: string;
    requestedStart: number;
    requestedEnd: number;
    appliedStart: number;
    appliedEnd: number;
  }>;
  skipPlan: {
    automaticRemovals: unknown[];
    manualRemovals: unknown[];
    episodes: Array<{ segments: Array<{ type: string; decision: string }> }>;
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

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fastify did not expose a TCP test address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(
    `${baseUrl}/api/v1/dev/cuts/from-upstream/auto`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        episodes: [1, 2, 3].map((episode) => ({
          episodeId: `ep${episode}`,
          type: "series",
          videoId: `tt1234567:1:${episode}`,
        })),
      }),
    },
  );
  cutBodyText = await response.text();
  if (!response.ok) throw new Error(`Automatic cut failed: ${cutBodyText}`);
  cut = JSON.parse(cutBodyText) as typeof cut;
  playlistUrl = `${baseUrl}${cut.playlistUrl}`;
  playlistText = await (await fetch(playlistUrl)).text();
});

afterAll(async () => {
  await app.close();
});

describe("real automatic Stremio to MediaFlow to AnimeTVCut composition", () => {
  it("creates the expected policy plan without manual removal input", () => {
    expect(cut.skipPlan.manualRemovals).toEqual([]);
    expect(cut.skipPlan.automaticRemovals).toHaveLength(4);
    expect(
      cut.skipPlan.episodes[0]!.segments.map((item) => item.decision),
    ).toEqual(["keep_first_opening", "remove"]);
    expect(
      cut.skipPlan.episodes[1]!.segments.map((item) => item.decision),
    ).toEqual(["remove", "remove"]);
    expect(
      cut.skipPlan.episodes[2]!.segments.map((item) => item.decision),
    ).toEqual(["remove", "keep_last_ending"]);
    expect(cut.appliedCuts).toHaveLength(4);
  });

  it("uses each normalized duration once and keeps it close to direct source duration", async () => {
    expect(requestedDurations).toHaveLength(3);
    expect(
      requestedDurations.every((duration) => Math.abs(duration - 30) < 0.1),
    ).toBe(true);
    const directDuration = Number(
      (
        await runMediaTool("ffprobe", [
          "-v",
          "error",
          "-headers",
          "X-Test-Token: stremio-upstream-secret\r\n",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          "http://127.0.0.1:18090/episode1.mkv",
        ])
      ).trim(),
    );
    expect(Math.abs(directDuration - requestedDurations[0]!)).toBeLessThan(0.1);
  });

  it("loads three MediaFlow playlists and no resources during automatic creation", async () => {
    const health = (await (
      await fetch(`${baseUrl}/api/v1/dev/mediaflow/health`)
    ).json()) as {
      requests: { playlistRequests: number; resourceRequests: number };
    };
    expect(health.requests).toMatchObject({
      playlistRequests: 3,
      resourceRequests: 0,
    });
    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    const segment = parsed.segments[0];
    if (segment === undefined) throw new Error("No composed media segment");
    expect((await fetch(segment.absoluteUri)).status).toBe(200);
    const after = (await (
      await fetch(`${baseUrl}/api/v1/dev/mediaflow/health`)
    ).json()) as { requests: { resourceRequests: number } };
    expect(after.requests.resourceRequests).toBe(1);
  });

  it("keeps all private upstream and provider details out of public artifacts", () => {
    expect(`${cutBodyText}\n${playlistText}`).not.toMatch(
      /stremio-upstream-secret|phase3-integration-password|test-secret|fixture-origin|api_password|signed=|token=/,
    );
  });

  it("reports H.264, AAC, and the expected automatic duration", async () => {
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

  it("decodes the full composition and both episode transitions", async () => {
    await decodeWindow(22, 4);
    await decodeWindow(40, 4);
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

  it("seeks into E2 and E3, then backward into E1", async () => {
    await decodeWindow(30, 1);
    await decodeWindow(50, 1);
    await decodeWindow(10, 1);
  });
});
