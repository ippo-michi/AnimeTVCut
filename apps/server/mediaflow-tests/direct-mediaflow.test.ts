import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const mediaFlowUrl = process.env.MEDIAFLOW_TEST_URL ?? "http://127.0.0.1:18888";
const originUrl =
  process.env.MEDIAFLOW_TEST_ORIGIN_URL ?? "http://fixture-origin:8090";
const originStatsUrl =
  process.env.MEDIAFLOW_TEST_ORIGIN_STATS_URL ?? "http://127.0.0.1:18090";
const password = "phase2-integration-password";
const sourceToken = "animetvcut-test";
const temporaryDirectories: string[] = [];

interface OriginStats {
  ranges: number;
  bytesServed: number;
  requests: Array<{
    method: string;
    pathname: string;
    statusCode: number;
    range: boolean;
    bytes: number;
  }>;
}

function transcodePlaylistUrl(fileName: string, noHeadSize = false): URL {
  const url = new URL("/proxy/transcode/playlist.m3u8", mediaFlowUrl);
  const source = new URL(`/${fileName}`, originUrl);
  if (noHeadSize) source.searchParams.set("head", "no-size");
  url.searchParams.set("d", source.toString());
  url.searchParams.set("api_password", password);
  url.searchParams.set("h_X-Test-Token", sourceToken);
  return url;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

async function probeFragments(
  init: Buffer,
  fragments: ReadonlyArray<Buffer>,
): Promise<{ codecs: string[]; packets: number }> {
  const directory = await mkdtemp(path.join(tmpdir(), "atc-mediaflow-"));
  temporaryDirectories.push(directory);
  const mediaPath = path.join(directory, "fragments.mp4");
  await writeFile(mediaPath, Buffer.concat([init, ...fragments]));
  const result = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_packets",
      "-show_entries",
      "stream=codec_name,codec_type,nb_read_packets",
      "-of",
      "json",
      mediaPath,
    ],
    { timeout: 60_000 },
  );
  const body = JSON.parse(result.stdout) as {
    streams: Array<{
      codec_name: string;
      codec_type: string;
      nb_read_packets?: string;
    }>;
  };
  return {
    codecs: body.streams.map(
      (stream) => `${stream.codec_type}:${stream.codec_name}`,
    ),
    packets: body.streams.reduce(
      (total, stream) => total + Number(stream.nb_read_packets ?? 0),
      0,
    ),
  };
}

async function exerciseSource(
  fileName: string,
  noHeadSize = false,
): Promise<{
  segmentSizes: number[];
  probe: Awaited<ReturnType<typeof probeFragments>>;
}> {
  const resetResponse = await fetch(`${originStatsUrl}/stats/reset`);
  expect(resetResponse.status).toBe(200);
  const playlistUrl = transcodePlaylistUrl(fileName, noHeadSize);
  const playlistResponse = await fetch(playlistUrl);
  expect(playlistResponse.status).toBe(200);
  const playlistText = await playlistResponse.text();
  const parsed = parseHlsVodPlaylist(playlistText, playlistUrl.toString());
  expect(parsed.segments.length).toBeGreaterThanOrEqual(2);
  const map = parsed.segments[0]?.map;
  expect(map).toBeDefined();
  const first = parsed.segments[0];
  const second = parsed.segments[1];
  if (map === undefined || first === undefined || second === undefined) {
    throw new Error("MediaFlow playlist omitted required fMP4 resources");
  }
  const init = await fetchBytes(map.absoluteUri);
  const fragments = await Promise.all([
    fetchBytes(first.absoluteUri),
    fetchBytes(second.absoluteUri),
  ]);
  const probe = await probeFragments(init, fragments);
  return { segmentSizes: fragments.map((fragment) => fragment.length), probe };
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("direct MediaFlow seekable source normalization", () => {
  it.each([
    ["H.264/AAC MP4", "control-h264-aac.mp4", false],
    ["H.264/AAC Matroska", "control-h264-aac.mkv", true],
    ["HEVC/Opus Matroska", "control-hevc-opus.mkv", false],
  ])("normalizes and decodes %s", async (_label, fileName, noHeadSize) => {
    const result = await exerciseSource(fileName, noHeadSize);
    expect(result.segmentSizes.every((size) => size > 1_000)).toBe(true);
    expect(result.probe.codecs).toEqual(
      expect.arrayContaining(["video:h264", "audio:aac"]),
    );
    expect(result.probe.packets).toBeGreaterThan(10);
  });

  it("uses HTTP byte ranges with standards-compliant 206 responses", async () => {
    const sourceResponse = await fetch(
      `${originStatsUrl}/control-h264-aac.mp4`,
      {
        headers: {
          Range: "bytes=0-99",
          "X-Test-Token": sourceToken,
        },
      },
    );
    expect(sourceResponse.status).toBe(206);
    expect(sourceResponse.headers.get("accept-ranges")).toBe("bytes");
    expect(sourceResponse.headers.get("content-range")).toMatch(
      /^bytes 0-99\/\d+$/,
    );
    expect((await sourceResponse.arrayBuffer()).byteLength).toBe(100);

    const statsResponse = await fetch(`${originStatsUrl}/stats`);
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as OriginStats;
    expect(stats.ranges).toBeGreaterThan(0);
    expect(
      stats.requests.some(
        (request) =>
          request.statusCode === 206 && request.range && request.bytes > 0,
      ),
    ).toBe(true);
  });

  it.each([
    ["AAC", "control-h264-aac.mkv", "aac"],
    ["E-AC-3", "control-h264-eac3.mkv", "eac3"],
  ])(
    "packet-copies %s continuously across MPEG-TS segment seams",
    async (_label, fileName, expectedCodec) => {
      const playlistUrl = transcodePlaylistUrl(fileName, true);
      playlistUrl.searchParams.set("atc_container", "mpegts");
      const result = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_name:packet=pts_time,duration_time",
          "-of",
          "json",
          playlistUrl.toString(),
        ],
        { timeout: 60_000 },
      );
      const probe = JSON.parse(result.stdout) as {
        streams: Array<{ codec_name: string }>;
        packets: Array<{ pts_time: string; duration_time: string }>;
      };
      expect(probe.streams[0]?.codec_name).toBe(expectedCodec);
      const packets = probe.packets;
      expect(packets.length).toBeGreaterThan(100);
      const gaps = packets.slice(1).map((packet, index) => {
        const previous = packets[index]!;
        return (
          Number(packet.pts_time) -
          (Number(previous.pts_time) + Number(previous.duration_time))
        );
      });
      expect(Math.max(...gaps.map(Math.abs))).toBeLessThan(0.001);
    },
  );

  it("opens and decodes the original MP4 independently of MediaFlow", async () => {
    const result = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-headers",
        `X-Test-Token: ${sourceToken}\r\n`,
        "-count_frames",
        "-show_entries",
        "stream=codec_name,codec_type,nb_read_frames",
        "-of",
        "json",
        `${originStatsUrl}/control-h264-aac.mp4`,
      ],
      { timeout: 60_000 },
    );
    const probe = JSON.parse(result.stdout) as {
      streams: Array<{
        codec_name: string;
        codec_type: string;
        nb_read_frames?: string;
      }>;
    };
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_name: "h264", codec_type: "video" }),
        expect.objectContaining({ codec_name: "aac", codec_type: "audio" }),
      ]),
    );
    expect(
      probe.streams.some((stream) => Number(stream.nb_read_frames ?? 0) > 2),
    ).toBe(true);
  });
});
