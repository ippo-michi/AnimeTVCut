import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildTimeline } from "@animetvcut/core";
import { composeHlsVod, parseHlsVodPlaylist } from "@animetvcut/hls";
import { afterAll, describe, expect, it } from "vitest";

import { MediaFlowClient } from "../src/services/mediaflow/client.js";

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

async function probeVideoPacketSpan(
  bytes: Buffer,
  extension: ".mp4" | ".ts",
): Promise<number> {
  const directory = await mkdtemp(path.join(tmpdir(), "atc-exact-span-"));
  temporaryDirectories.push(directory);
  const mediaPath = path.join(directory, `exact${extension}`);
  await writeFile(mediaPath, bytes);
  const result = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "json",
      mediaPath,
    ],
    { timeout: 60_000 },
  );
  const body = JSON.parse(result.stdout) as {
    packets: Array<{ pts_time?: string; duration_time?: string }>;
  };
  const packets = body.packets
    .map((packet) => ({
      start: Number(packet.pts_time),
      duration: Number(packet.duration_time ?? 0),
    }))
    .filter((packet) => Number.isFinite(packet.start));
  expect(packets.length).toBeGreaterThan(1);
  const start = Math.min(...packets.map((packet) => packet.start));
  const end = Math.max(
    ...packets.map((packet) => packet.start + packet.duration),
  );
  return end - start;
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

  it("physically trims exact fMP4 boundary fragments", async () => {
    const playlistUrl = transcodePlaylistUrl("control-h264-aac.mkv", true);
    playlistUrl.searchParams.set("atc_exact", "1");
    const playlistResponse = await fetch(playlistUrl);
    expect(playlistResponse.status).toBe(200);
    const parsed = parseHlsVodPlaylist(
      await playlistResponse.text(),
      playlistUrl.toString(),
    );
    const first = parsed.segments[0];
    const map = first?.map;
    expect(first).toBeDefined();
    expect(map).toBeDefined();
    if (first === undefined || map === undefined) {
      throw new Error("Exact fMP4 test requires an init map and segment");
    }
    const start = first.start + 0.75;
    const end = first.end - 0.75;
    expect(end - start).toBeGreaterThan(1);
    const segmentUrl = new URL(first.absoluteUri);
    segmentUrl.searchParams.set("start_ms", String(Math.round(start * 1000)));
    segmentUrl.searchParams.set("end_ms", String(Math.round(end * 1000)));
    segmentUrl.searchParams.set("atc_exact", "1");
    const [init, fragment] = await Promise.all([
      fetchBytes(map.absoluteUri),
      fetchBytes(segmentUrl.toString()),
    ]);
    const span = await probeVideoPacketSpan(
      Buffer.concat([init, fragment]),
      ".mp4",
    );
    expect(Math.abs(span - (end - start))).toBeLessThan(0.2);
  });

  it("physically trims exact MPEG-TS boundary fragments", async () => {
    const playlistUrl = transcodePlaylistUrl("control-h264-aac.mkv", true);
    playlistUrl.searchParams.set("atc_container", "mpegts");
    playlistUrl.searchParams.set("atc_exact", "1");
    const playlistResponse = await fetch(playlistUrl);
    expect(playlistResponse.status).toBe(200);
    const parsed = parseHlsVodPlaylist(
      await playlistResponse.text(),
      playlistUrl.toString(),
    );
    const first = parsed.segments[0];
    expect(first).toBeDefined();
    if (first === undefined)
      throw new Error("Exact TS test requires a segment");
    const start = first.start + 0.75;
    const end = first.end - 0.75;
    expect(end - start).toBeGreaterThan(1);
    const segmentUrl = new URL(first.absoluteUri);
    segmentUrl.searchParams.set("start_ms", String(Math.round(start * 1000)));
    segmentUrl.searchParams.set("end_ms", String(Math.round(end * 1000)));
    segmentUrl.searchParams.set("atc_output_start_ms", "0");
    segmentUrl.searchParams.set("atc_exact", "1");
    const fragment = await fetchBytes(segmentUrl.toString());
    const span = await probeVideoPacketSpan(fragment, ".ts");
    expect(Math.abs(span - (end - start))).toBeLessThan(0.25);
  });

  it.each(
    [
      "control-h264-aac.mkv",
      "control-h264-flac.mkv",
      "control-hevc-opus.mkv",
    ].flatMap((file) => ["head", "tail"].map((edge) => ({ file, edge }))),
  )(
    "decodes a coalesced one-millisecond $edge fragment from $file without losing retained footage",
    async ({ edge, file }) => {
      const client = new MediaFlowClient({
        baseUrl: mediaFlowUrl,
        apiPassword: password,
        outputContainer: "mpegts",
      });
      const playlist = await client.loadTranscodePlaylist({
        kind: "http_media",
        episodeId: "subframe",
        url: `${originUrl}/${file}`,
        headers: { "X-Test-Token": sourceToken },
      });
      const first = playlist.segments[0]!,
        second = playlist.segments[1]!;
      const sourceStart = edge === "head" ? second.start - 0.001 : first.start;
      const sourceEnd = edge === "head" ? second.end : first.end + 0.001;
      const composed = composeHlsVod(
        "subframe",
        [{ episodeId: "subframe", playlist }],
        buildTimeline([
          {
            sourceEpisodeId: "subframe",
            sourceStart,
            sourceEnd,
            kind: "content",
          },
        ]),
      );
      expect(composed.resources).toHaveLength(1);
      expect(composed.duration).toBeCloseTo(sourceEnd - sourceStart, 6);
      const resource = composed.resources[0]!;
      expect(resource.sourceStart).toBeCloseTo(
        (first.mediaStart ?? first.start) + sourceStart,
        6,
      );
      expect(resource.sourceEnd! - resource.sourceStart!).toBeCloseTo(
        composed.duration,
        6,
      );
      const opened = await client.createLazyResource(resource).open();
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBeGreaterThan(0);
      expect(
        Math.abs(
          (await probeVideoPacketSpan(bytes, ".ts")) - composed.duration,
        ),
      ).toBeLessThan(0.15);
      const directory = await mkdtemp(path.join(tmpdir(), "atc-subframe-"));
      temporaryDirectories.push(directory);
      const mediaPath = path.join(directory, "joined.ts");
      await writeFile(mediaPath, bytes);
      const decoded = await execFileAsync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          mediaPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          "-f",
          "null",
          "-",
          "-progress",
          "pipe:1",
        ],
        { timeout: 60_000 },
      );
      expect(decoded.stdout).toContain("progress=end");
      expect(
        Number([...decoded.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]),
      ).toBeGreaterThan(1);
    },
  );

  it.each(["aac", "pcm"])(
    "keeps copied and exact-cut MPEG-TS on one timeline with %s audio",
    async (audio) => {
      const client = new MediaFlowClient({
        baseUrl: mediaFlowUrl,
        apiPassword: password,
        outputContainer: "mpegts",
      });
      const playlist = await client.loadTranscodePlaylist({
        kind: "http_media",
        episodeId: "mixed",
        url: `${originUrl}/control-h264-${audio}.mkv`,
        headers: { "X-Test-Token": sourceToken },
      });
      const second = playlist.segments[1]!;
      const composed = composeHlsVod(
        "mixed",
        [{ episodeId: "mixed", playlist }],
        buildTimeline(
          [
            [0, second.start + 0.75],
            [second.end - 0.75, playlist.duration],
          ].map(([sourceStart, sourceEnd]) => ({
            sourceEpisodeId: "mixed",
            sourceStart: sourceStart!,
            sourceEnd: sourceEnd!,
            kind: "content" as const,
          })),
        ),
      );
      expect(composed.resources.length).toBeGreaterThanOrEqual(4);
      const directory = await mkdtemp(path.join(tmpdir(), "atc-mixed-timing-"));
      temporaryDirectories.push(directory);
      for (const resource of composed.resources) {
        const opened = await client.createLazyResource(resource).open();
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const mediaPath = path.join(directory, resource.id);
        await writeFile(mediaPath, Buffer.concat(chunks));
        const result = await execFileAsync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "packet=stream_index,pts_time,duration_time",
          "-of",
          "json",
          mediaPath,
        ]);
        const { packets } = JSON.parse(result.stdout) as {
          packets: Array<{
            stream_index: number;
            pts_time: string;
            duration_time: string;
          }>;
        };
        for (const index of [0, 1]) {
          const track = packets.filter(
            (packet) => packet.stream_index === index,
          );
          expect(track.length).toBeGreaterThan(0);
          const start = Math.min(
            ...track.map((packet) => Number(packet.pts_time)),
          );
          const end = Math.max(
            ...track.map(
              (packet) =>
                Number(packet.pts_time) + Number(packet.duration_time),
            ),
          );
          // Copied AAC packets follow cluster ownership and can straddle
          // a declared video boundary.
          const tolerance = index === 0 ? 0.08 : 0.125;
          expect(Math.abs(start - resource.outputStart!)).toBeLessThan(
            tolerance,
          );
          expect(
            Math.abs(
              end -
                (resource.outputStart! +
                  resource.sourceEnd! -
                  resource.sourceStart!),
            ),
          ).toBeLessThan(tolerance);
        }
      }
    },
  );

  it("decodes composed cuts with large MKV tracks and a nonzero time origin", async () => {
    const client = new MediaFlowClient({
      baseUrl: mediaFlowUrl,
      apiPassword: password,
      outputContainer: "mpegts",
    });
    const playlist = await client.loadTranscodePlaylist({
      kind: "http_media",
      episodeId: "large-tracks",
      url: `${originUrl}/control-h264-large-tracks.mkv`,
      headers: { "X-Test-Token": sourceToken },
    });
    expect(playlist.segments[0]!.mediaStart).toBeGreaterThan(0);
    const composed = composeHlsVod(
      "large-tracks",
      [{ episodeId: "large-tracks", playlist }],
      buildTimeline([
        {
          sourceEpisodeId: "large-tracks",
          sourceStart: 0,
          sourceEnd: playlist.duration,
          kind: "content",
        },
      ]),
    );
    const fragments: Buffer[] = [];
    for (const resource of composed.resources) {
      const opened = await client.createLazyResource(resource).open();
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      fragments.push(Buffer.concat(chunks));
    }
    const span = await probeVideoPacketSpan(Buffer.concat(fragments), ".ts");
    expect(Math.abs(span - playlist.duration)).toBeLessThan(0.25);
    const directory = await mkdtemp(path.join(tmpdir(), "atc-large-tracks-"));
    temporaryDirectories.push(directory);
    const mediaPath = path.join(directory, "cut.ts");
    await writeFile(mediaPath, Buffer.concat(fragments));
    await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", mediaPath, "-f", "null", "-"],
      { timeout: 60_000 },
    );
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

  it("normalizes an MP4 source into seekable MPEG-TS", async () => {
    const playlistUrl = transcodePlaylistUrl("control-h264-aac.mp4");
    playlistUrl.searchParams.set("atc_container", "mpegts");
    const result = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type:format=duration",
        "-of",
        "json",
        playlistUrl.toString(),
      ],
      { timeout: 60_000 },
    );
    const probe = JSON.parse(result.stdout) as {
      streams: Array<{ codec_name: string; codec_type: string }>;
      format: { duration: string };
    };
    expect(probe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_name: "h264", codec_type: "video" }),
        expect.objectContaining({ codec_name: "aac", codec_type: "audio" }),
      ]),
    );
    expect(Number(probe.format.duration)).toBeGreaterThan(17);
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

  it.each([
    ["AAC", "control-h264-aac.mkv"],
    ["E-AC-3", "control-h264-eac3.mkv"],
    ["PCM", "control-h264-pcm.mkv"],
  ])(
    "keeps the boundary H.264 GOP across %s MPEG-TS segment seams",
    async (_label, fileName) => {
      const playlistUrl = transcodePlaylistUrl(fileName, true);
      playlistUrl.searchParams.set("atc_container", "mpegts");
      const result = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=codec_name:packet=dts_time,duration_time,flags",
          "-of",
          "json",
          playlistUrl.toString(),
        ],
        { timeout: 60_000 },
      );
      const probe = JSON.parse(result.stdout) as {
        streams: Array<{ codec_name: string }>;
        packets: Array<{
          dts_time?: string;
          duration_time: string;
          flags: string;
        }>;
      };
      expect(probe.streams[0]?.codec_name).toBe("h264");
      const packets = probe.packets.filter(
        (packet): packet is typeof packet & { dts_time: string } =>
          packet.dts_time !== undefined,
      );
      expect(packets.length).toBeGreaterThan(100);
      const gaps = packets.slice(1).map((packet, index) => {
        const previous = packets[index]!;
        return (
          Number(packet.dts_time) -
          (Number(previous.dts_time) + Number(previous.duration_time))
        );
      });
      // One frame of rounding is acceptable. Missing a boundary GOP creates
      // the visible 0.5-2 second freeze this regression guards against.
      expect(Math.max(...gaps.map(Math.abs))).toBeLessThan(0.05);
    },
  );

  it("keeps normalized FLAC audio timestamps continuous across seams", async () => {
    const playlistUrl = transcodePlaylistUrl("control-h264-flac.mkv", true);
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
    expect(probe.streams[0]?.codec_name).toBe("aac");
    const gaps = probe.packets.slice(1).map((packet, index) => {
      const previous = probe.packets[index]!;
      return (
        Number(packet.pts_time) -
        (Number(previous.pts_time) + Number(previous.duration_time))
      );
    });
    expect(Math.max(...gaps.map(Math.abs))).toBeLessThan(0.001);
  });

  it.each([
    ["44.1 kHz FLAC", "control-h264-flac-offset.mkv"],
    ["48 kHz PCM", "control-h264-pcm-offset.mkv"],
    ["48 kHz FLAC", "control-h264-flac.mkv"],
  ])(
    "plays %s through MPV without repeated AAC padding",
    async (_label, fileName) => {
      const client = new MediaFlowClient({
        baseUrl: mediaFlowUrl,
        apiPassword: password,
        outputContainer: "mpegts",
      });
      const playlist = await client.loadTranscodePlaylist({
        kind: "http_media",
        episodeId: "tone",
        url: `${originUrl}/${fileName}`,
        headers: { "X-Test-Token": sourceToken },
      });
      const cutStart = playlist.segments[1]!.start + 0.75;
      const composed = composeHlsVod(
        "tone",
        [{ episodeId: "tone", playlist }],
        buildTimeline(
          [
            [0, cutStart],
            [cutStart + 1, playlist.duration],
          ].map(([sourceStart, sourceEnd]) => ({
            sourceEpisodeId: "tone",
            sourceStart: sourceStart!,
            sourceEnd: sourceEnd!,
            kind: "content" as const,
          })),
        ),
      );
      const directory = await mkdtemp(path.join(tmpdir(), "atc-audio-seams-"));
      temporaryDirectories.push(directory);
      let previousEnd: number | undefined;
      let totalSamples = 0;
      const seams: number[] = [];
      for (const resource of composed.resources) {
        const opened = await client.createLazyResource(resource).open();
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        const mediaPath = path.join(directory, resource.id);
        await writeFile(mediaPath, Buffer.concat(chunks));
        const result = await execFileAsync("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          mediaPath,
        ]);
        const { packets } = JSON.parse(result.stdout) as {
          packets: Array<{ pts_time: string; duration_time: string }>;
        };
        expect(packets.length).toBeGreaterThan(0);
        const first = Number(packets[0]!.pts_time);
        if (previousEnd !== undefined) {
          expect(
            Math.abs(first - previousEnd),
            `${resource.id} audio gap/overlap`,
          ).toBeLessThan(0.000025);
          seams.push(totalSamples);
        }
        for (const packet of packets) {
          const pts = Number(packet.pts_time);
          if (previousEnd !== undefined)
            expect(Math.abs(pts - previousEnd)).toBeLessThan(0.000025);
          previousEnd = pts + Number(packet.duration_time);
        }
        totalSamples += packets.length * 1024;
      }
      let localPlaylist = composed.text;
      for (const resource of composed.resources)
        localPlaylist = localPlaylist.replace(
          `/media/cut/tone/segment/${resource.id}`,
          path.join(directory, resource.id),
        );
      const playlistPath = path.join(directory, "tone.m3u8");
      const pcmPath = path.join(directory, "mpv.pcm");
      await writeFile(playlistPath, localPlaylist);
      await execFileAsync(
        "mpv",
        [
          "--no-config",
          "--no-video",
          "--ao=pcm",
          `--ao-pcm-file=${pcmPath}`,
          "--ao-pcm-waveheader=no",
          "--audio-format=float",
          "--audio-channels=mono",
          "--audio-samplerate=48000",
          playlistPath,
        ],
        { timeout: 60_000 },
      );
      const pcm = await readFile(pcmPath);
      expect(Math.abs(pcm.length / 4 - totalSamples)).toBeLessThanOrEqual(1);
      const rms = (start: number, length: number) => {
        let sum = 0;
        for (let n = start; n < start + length; n++)
          sum += pcm.readFloatLE(n * 4) ** 2;
        return Math.sqrt(sum / length);
      };
      const interior = rms(48000, 4800);
      expect(interior).toBeGreaterThan(0.02);
      // Priming/padded AAC packets dropped a steady tone below 1% amplitude.
      // Allow lossy overlap windows around a cut while rejecting that dropout.
      for (const seam of seams) {
        for (let offset = -1920; offset < 1920; offset += 240) {
          expect(
            rms(seam + offset, 240),
            `dropout at sample ${seam + offset}`,
          ).toBeGreaterThan(interior * 0.25);
        }
      }
    },
  );

  it("marks independent MPEG-TS continuity-counter resets", async () => {
    const playlistUrl = transcodePlaylistUrl("control-h264-aac.mkv", true);
    playlistUrl.searchParams.set("atc_container", "mpegts");
    const result = await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "warning",
        "-i",
        playlistUrl.toString(),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      { timeout: 60_000 },
    );
    expect(result.stderr).not.toContain("Packet corrupt");
    expect(result.stderr).not.toContain("corrupt input packet");
  });

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
