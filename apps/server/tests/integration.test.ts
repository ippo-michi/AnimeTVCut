import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const execFileAsync = promisify(execFile);
const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
let baseUrl: string;
let playlistUrl: string;
let playlistText: string;
let cutResponse: {
  cutId: string;
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
    requestedStart: number;
    requestedEnd: number;
    appliedStart: number;
    appliedEnd: number;
  }>;
};

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

function mediaInput(input: string): string {
  if (process.platform !== "win32") {
    return input;
  }
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (match?.[1] === undefined || match[2] === undefined) {
    return input;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

async function decodeWindow(start: number, duration: number): Promise<void> {
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

async function frameHash(input: string, time: number): Promise<string> {
  const output = await runMediaTool("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    mediaInput(input),
    "-ss",
    String(time),
    "-frames:v",
    "1",
    "-an",
    "-vf",
    "scale=16:16",
    "-f",
    "framemd5",
    "-",
  ]);
  const frameLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  const hash = frameLine?.split(",").at(-1)?.trim();
  if (hash === undefined) {
    throw new Error(`FFmpeg returned no frame hash for ${input} at ${time}`);
  }
  return hash;
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
      sources: [
        { episodeId: "ep1", playlistUrl: "fixture://episode1" },
        { episodeId: "ep2", playlistUrl: "fixture://episode2" },
        { episodeId: "ep3", playlistUrl: "fixture://episode3" },
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
    throw new Error(`Cut creation failed: ${await response.text()}`);
  }
  cutResponse = (await response.json()) as typeof cutResponse;
  playlistUrl = `${baseUrl}${cutResponse.playlistUrl}`;
  const playlistResponse = await fetch(playlistUrl);
  playlistText = await playlistResponse.text();
});

afterAll(async () => {
  await app.close();
});

describe("three-episode local HLS composition", () => {
  it("composes three playlists and keeps only the intended ranges", () => {
    expect(
      cutResponse.pieces.map(
        ({
          sourceEpisodeId,
          sourceStart,
          sourceEnd,
          outputStart,
          outputEnd,
        }) => ({
          sourceEpisodeId,
          sourceStart,
          sourceEnd,
          outputStart,
          outputEnd,
        }),
      ),
    ).toEqual([
      {
        sourceEpisodeId: "ep1",
        sourceStart: 0,
        sourceEnd: 24,
        outputStart: 0,
        outputEnd: 24,
      },
      {
        sourceEpisodeId: "ep2",
        sourceStart: 6,
        sourceEnd: 24,
        outputStart: 24,
        outputEnd: 42,
      },
      {
        sourceEpisodeId: "ep3",
        sourceStart: 6,
        sourceEnd: 30,
        outputStart: 42,
        outputEnd: 66,
      },
    ]);
    expect(cutResponse.appliedCuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          episodeId: "ep1",
          appliedStart: 24,
          appliedEnd: 30,
        }),
        expect.objectContaining({
          episodeId: "ep2",
          appliedStart: 0,
          appliedEnd: 6,
        }),
        expect.objectContaining({
          episodeId: "ep2",
          appliedStart: 24,
          appliedEnd: 30,
        }),
        expect.objectContaining({
          episodeId: "ep3",
          appliedStart: 0,
          appliedEnd: 6,
        }),
      ]),
    );
  });

  it("produces a valid opaque VOD playlist", () => {
    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    expect(parsed.segments).toHaveLength(11);
    expect(playlistText).toContain("#EXT-X-ENDLIST");
    expect(playlistText.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(playlistText).not.toContain("fixture://");
    expect(playlistText).not.toContain("episode1");
    expect(playlistText).not.toContain("seg00.ts");
    expect(parsed.targetDuration).toBeGreaterThanOrEqual(
      Math.round(
        Math.max(...parsed.segments.map((segment) => segment.duration)),
      ),
    );
    expect(Math.abs(parsed.duration - cutResponse.duration)).toBeLessThan(
      0.001,
    );
    expect(Math.abs(cutResponse.duration - 66)).toBeLessThanOrEqual(
      parsed.targetDuration,
    );
  });

  it("returns the same manifest for repeated requests within a session", async () => {
    const repeated = await fetch(playlistUrl);
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toBe(playlistText);
  });

  it("resolves every synthetic segment URL", async () => {
    const parsed = parseHlsVodPlaylist(playlistText, playlistUrl);
    for (const segment of parsed.segments) {
      const response = await fetch(segment.absoluteUri);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("video/mp2t");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  it("retains the first opening and last ending while removing all middle bumpers", async () => {
    const ep1 = path.resolve("fixtures/hls/episode1/playlist.m3u8");
    const ep2 = path.resolve("fixtures/hls/episode2/playlist.m3u8");
    const ep3 = path.resolve("fixtures/hls/episode3/playlist.m3u8");
    const sourceFirstOpening = await frameHash(ep1, 2);
    const sourceE1Story = await frameHash(ep1, 22);
    const sourceE1Ending = await frameHash(ep1, 26);
    const sourceE2Opening = await frameHash(ep2, 2);
    const sourceE2Story = await frameHash(ep2, 8);
    const sourceE2Ending = await frameHash(ep2, 26);
    const sourceE3Opening = await frameHash(ep3, 2);
    const sourceE3Story = await frameHash(ep3, 8);
    const sourceLastEnding = await frameHash(ep3, 26);
    const outputFirstOpening = await frameHash(playlistUrl, 2);
    const outputE1Tail = await frameHash(playlistUrl, 22);
    const outputE2Start = await frameHash(playlistUrl, 26);
    const outputE2Tail = await frameHash(playlistUrl, 38);
    const outputE3Start = await frameHash(playlistUrl, 44);
    const outputLastEnding = await frameHash(playlistUrl, 62);

    expect(outputFirstOpening).toBe(sourceFirstOpening);
    expect(outputE1Tail).toBe(sourceE1Story);
    expect(outputE1Tail).not.toBe(sourceE1Ending);
    expect(outputE2Start).toBe(sourceE2Story);
    expect(outputE2Start).not.toBe(sourceE2Opening);
    expect(outputE2Tail).toBe(sourceE2Story);
    expect(outputE2Tail).not.toBe(sourceE2Ending);
    expect(outputE3Start).toBe(sourceE3Story);
    expect(outputE3Start).not.toBe(sourceE3Opening);
    expect(outputLastEnding).toBe(sourceLastEnding);
  });

  it("is recognized by FFprobe with the calculated duration", async () => {
    const output = await runMediaTool("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      playlistUrl,
    ]);
    const probe = JSON.parse(output) as { format: { duration: string } };
    expect(
      Math.abs(Number.parseFloat(probe.format.duration) - cutResponse.duration),
    ).toBeLessThan(1);
  });

  it("plays through E1 to E2", async () => {
    await decodeWindow(22, 4);
  });

  it("plays through E2 to E3", async () => {
    await decodeWindow(40, 4);
  });

  it("seeks directly into E2", async () => {
    await decodeWindow(30, 1);
  });

  it("seeks directly into E3 and back into E1", async () => {
    await decodeWindow(50, 1);
    await decodeWindow(10, 1);
  });

  it("decodes the complete composed stream with video and audio", async () => {
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
