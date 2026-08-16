import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
let playlistUrl: string;
let playlistText: string;
let duration: number;

async function runMediaTool(
  tool: "ffmpeg" | "ffprobe",
  args: string[],
): Promise<string> {
  const executable = process.platform === "win32" ? "wsl.exe" : tool;
  const actualArgs =
    process.platform === "win32" ? ["--exec", tool, ...args] : args;
  const result = await execFileAsync(executable, actualArgs, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/v1/dev/cuts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [
        { episodeId: "ep1", playlistUrl: "fixture://fmp4-episode1" },
        { episodeId: "ep2", playlistUrl: "fixture://fmp4-episode2" },
        { episodeId: "ep3", playlistUrl: "fixture://fmp4-episode3" },
      ],
      remove: [
        { episodeId: "ep1", start: 24, end: 30, type: "ending" },
        { episodeId: "ep2", start: 0, end: 6, type: "opening" },
        { episodeId: "ep2", start: 24, end: 30, type: "ending" },
        { episodeId: "ep3", start: 0, end: 6, type: "opening" },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`fMP4 cut creation failed: ${await response.text()}`);
  }
  const cut = (await response.json()) as {
    duration: number;
    playlistUrl: string;
  };
  duration = cut.duration;
  playlistUrl = `${baseUrl}${cut.playlistUrl}`;
  const playlistResponse = await fetch(playlistUrl);
  playlistText = await playlistResponse.text();
});

afterAll(async () => {
  await app.close();
});

describe("three-episode fMP4 HLS composition", () => {
  it("parses with three opaque initialization maps and eleven fMP4 segments", async () => {
    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    const maps = [
      ...new Map(
        parsed.segments.flatMap((segment) =>
          segment.map === undefined
            ? []
            : [[segment.map.absoluteUri, segment.map]],
        ),
      ).values(),
    ];
    expect(parsed.segments).toHaveLength(11);
    expect(maps).toHaveLength(3);
    expect(playlistText.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(7);
    expect(playlistText).not.toContain("fixture://");
    expect(playlistText).not.toContain("init.mp4");
    expect(playlistText).not.toContain("seg00.m4s");

    for (const map of maps) {
      expect(new URL(map.absoluteUri).pathname).toMatch(/\/r\d+\.mp4$/);
      const response = await fetch(map.absoluteUri);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("video/mp4");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    for (const segment of parsed.segments) {
      expect(segment.mediaFormat).toBe("fmp4");
      expect(new URL(segment.absoluteUri).pathname).toMatch(/\/r\d+\.m4s$/);
      const response = await fetch(segment.absoluteUri);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("video/mp4");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  it("reports audio, video, and the calculated duration through FFprobe", async () => {
    const output = await runMediaTool("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      playlistUrl,
    ]);
    const probe = JSON.parse(output) as {
      streams: Array<{ codec_type: string }>;
      format: { duration: string };
    };
    expect(probe.streams.map((stream) => stream.codec_type)).toEqual(
      expect.arrayContaining(["video", "audio"]),
    );
    expect(
      Math.abs(Number.parseFloat(probe.format.duration) - duration),
    ).toBeLessThan(1);
    expect(Math.abs(duration - 66)).toBeLessThanOrEqual(6);
  });

  it("decodes across E1 to E2 with the replacement init map", async () => {
    await decodeWindow(22, 4);
  });

  it("decodes across E2 to E3 with the replacement init map", async () => {
    await decodeWindow(40, 4);
  });

  it("seeks into E2, E3, and backward into E1", async () => {
    await decodeWindow(30, 1);
    await decodeWindow(50, 1);
    await decodeWindow(10, 1);
  });

  it("decodes the complete fMP4 composition with audio and video", async () => {
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
