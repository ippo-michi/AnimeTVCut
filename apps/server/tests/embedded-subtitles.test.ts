import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EmbeddedSubtitleService } from "../src/services/embedded-subtitles.js";
import { SubtitleService } from "../src/services/subtitle-service.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import { createSubtitleConfig } from "../src/services/subtitle-config.js";
import type { CandidateFamilySelection } from "../src/services/stremio-upstream/types.js";
import { SessionPersistence } from "../src/services/session-persistence.js";

const exec = promisify(execFile);
let directory: string;
let origin: string;
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\i1}Styled line\n`;
const media = new Map<string, Buffer>();
const requests = new Map<string, number>();
const server = createServer((req, res) => {
  if (req.headers["x-fixture"] !== "private" && req.url !== "/broken") {
    res.writeHead(403).end();
    return;
  }
  const bytes = media.get(req.url ?? "");
  if (!bytes) {
    res.writeHead(404).end();
    return;
  }
  requests.set(req.url ?? "", (requests.get(req.url ?? "") ?? 0) + 1);
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  const start = match ? Number(match[1]) : 0,
    end = match?.[2]
      ? Math.min(Number(match[2]), bytes.length - 1)
      : bytes.length - 1;
  res.writeHead(match ? 206 : 200, {
    "content-type": "video/x-matroska",
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    ...(match
      ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
      : {}),
  });
  res.end(bytes.subarray(start, end + 1));
});
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "atc-embedded-"));
  await writeFile(
    path.join(directory, "track.srt"),
    "1\n00:00:00,500 --> 00:00:01,500\nHello episode\n",
  );
  await writeFile(path.join(directory, "track.ass"), ass);
  for (const extension of ["srt", "ass"]) {
    const destination = path.join(directory, `source-${extension}.mkv`);
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=black:s=32x32:r=5:d=2",
      "-i",
      path.join(directory, `track.${extension}`),
      "-map",
      "0:v",
      "-map",
      "1:s",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:s",
      extension === "srt" ? "srt" : "ass",
      "-metadata:s:s:0",
      "language=eng",
      destination,
    ]);
    media.set(`/${extension}.mkv`, await readFile(destination));
  }
  const multi = path.join(directory, "multi.mkv");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-i",
    path.join(directory, "source-srt.mkv"),
    "-i",
    path.join(directory, "track.srt"),
    "-map",
    "0",
    "-map",
    "1:s",
    "-c",
    "copy",
    "-metadata:s:s:1",
    "language=jpn",
    multi,
  ]);
  media.set("/multi.mkv", await readFile(multi));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  origin = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
});
const source = (episodeId = "e1", extension = "srt") => ({
  kind: "http_media" as const,
  episodeId,
  url: `${origin}/${extension}.mkv`,
  headers: { "X-Fixture": "private" },
});
function selection(extension = "srt"): CandidateFamilySelection {
  return {
    familyMethod: "binge_group",
    familyKey: "fixture",
    warnings: [],
    unsupported: {
      torrent: 0,
      usenet: 0,
      archive: 0,
      youtube: 0,
      external: 0,
      unsupported: 0,
    },
    episodes: ["e1", "e2"].map((episodeId) => ({
      episodeId,
      upstreamType: "series",
      upstreamVideoId: episodeId,
      upstreamRank: 0,
      familyMethod: "binge_group",
      familyKey: "fixture",
      subtitles: [],
      mediaSource: source(episodeId, extension),
    })),
  };
}
function session(store: CutSessionStore) {
  store.save({
    id: "embedded-cut",
    duration: 2,
    playlist: "#EXTM3U",
    pieces: ["e1", "e2"].map((id, i) => ({
      id,
      sourceEpisodeId: id,
      sourceStart: 0.5,
      sourceEnd: 1.5,
      outputStart: i,
      outputEnd: i + 1,
      kind: "content",
    })),
    resources: new Map(),
    appliedCuts: [],
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
    outputSkipSegments: [],
    outputSkipDiagnostics: [],
  });
}

describe("embedded text subtitle fallback", () => {
  it("extracts multiple original languages in one shared source read and caches the results", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source("e1", "multi");
    const tracks = await reader.discover(input);
    expect(tracks.map((track) => track.lang)).toEqual(["eng", "jpn"]);
    const before = requests.get("/multi.mkv") ?? 0;
    const [english, japanese] = await Promise.all(
      tracks.map((track) => reader.extract(input, track)),
    );
    const after = requests.get("/multi.mkv") ?? 0;
    expect(new TextDecoder().decode(english!.bytes)).toContain("Hello episode");
    expect(new TextDecoder().decode(japanese!.bytes)).toContain(
      "Hello episode",
    );
    expect(after - before).toBe(1);
    await reader.extract(input, tracks[0]!);
    expect(requests.get("/multi.mkv")).toBe(after);
  });
  it("samples an embedded track using source timestamps", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source();
    const [track] = await reader.discover(input);
    const sample = await reader.sample(input, track!, { start: 0.2, end: 1.8 });
    expect(new TextDecoder().decode(sample.bytes)).toContain(
      "00:00:00,500 --> 00:00:01,500",
    );
  });
  it("keeps a shared extraction alive when one subtitle request is cancelled", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source("e1", "multi");
    const tracks = await reader.discover(input);
    const controller = new AbortController();
    const cancelled = reader.extract(input, tracks[0]!, controller.signal);
    const remaining = reader.extract(input, tracks[1]!);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(new TextDecoder().decode((await remaining).bytes)).toContain(
      "Hello episode",
    );
  });
  it("retains a cancelled extraction for an active playback and serves it from cache", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source("e1", "multi");
    const [track] = await reader.discover(input);
    const before = requests.get("/multi.mkv") ?? 0;
    const controller = new AbortController();
    const cancelled = reader.extract(
      input,
      track!,
      controller.signal,
      () => true,
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    // Let the work finish without an HTTP waiter, as happens after a client timeout.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((requests.get("/multi.mkv") ?? 0) - before).toBe(1);
    const next = await reader.extract(input, track!);
    expect(new TextDecoder().decode(next.bytes)).toContain("Hello episode");
    expect((requests.get("/multi.mkv") ?? 0) - before).toBe(1);
    await reader.extract(input, track!);
    expect((requests.get("/multi.mkv") ?? 0) - before).toBe(1);
  });
  it("stops cancelled extraction when playback is no longer active", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source("e1", "multi");
    const [track] = await reader.discover(input);
    const before = requests.get("/multi.mkv") ?? 0;
    const controller = new AbortController();
    const cancelled = reader.extract(
      input,
      track!,
      controller.signal,
      () => false,
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(requests.get("/multi.mkv")).toBe(before);
  });
  it("reuses a completed background extraction when a playing client retries", async () => {
    const reader = new EmbeddedSubtitleService();
    const store = new CutSessionStore();
    session(store);
    const service = new SubtitleService(
      createSubtitleConfig(),
      store,
      undefined,
      undefined,
      reader,
    );
    const [track] = await service.discover("embedded-cut", selection());
    const before = requests.get("/srt.mkv") ?? 0;
    const controller = new AbortController();
    const pending = service.compose(
      "embedded-cut",
      track!.id,
      track!.extension,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = requests.get("/srt.mkv") ?? 0;
    expect(after - before).toBe(1);
    const retried = await service.compose(
      "embedded-cut",
      track!.id,
      track!.extension,
    );
    expect(new TextDecoder().decode(retried!.bytes)).toContain("Hello episode");
    expect(requests.get("/srt.mkv")).toBe(after);
  });
  it("prioritizes a short sync sample over the simultaneous full-track read", async () => {
    const reader = new EmbeddedSubtitleService();
    const input = source("e1", "multi");
    const [track] = await reader.discover(input);
    const before = requests.get("/multi.mkv") ?? 0;
    const full = reader.extract(input, track!);
    const sample = reader.sample(input, track!, { start: 0.2, end: 1.8 });
    expect(new TextDecoder().decode((await sample).bytes)).toContain(
      "Hello episode",
    );
    expect((requests.get("/multi.mkv") ?? 0) - before).toBe(1);
    await full;
    expect((requests.get("/multi.mkv") ?? 0) - before).toBe(2);
  });
  it.each(["srt", "ass"])(
    "discovers authenticated HTTP MKV %s tracks, extracts lazily and maps both episodes",
    async (extension) => {
      const reader = new EmbeddedSubtitleService();
      const extract = vi.spyOn(reader, "extract");
      const store = new CutSessionStore();
      session(store);
      const service = new SubtitleService(
        createSubtitleConfig(),
        store,
        undefined,
        undefined,
        reader,
      );
      const tracks = await service.discover(
        "embedded-cut",
        selection(extension),
      );
      expect(tracks).toHaveLength(1);
      expect(extract).not.toHaveBeenCalled();
      expect(JSON.stringify(service.diagnostics("embedded-cut"))).not.toContain(
        origin,
      );
      const track = tracks[0]!;
      const first = await service.compose(
        "embedded-cut",
        track.id,
        track.extension,
      );
      expect(first).toBeDefined();
      const text = new TextDecoder().decode(first!.bytes);
      if (extension === "srt") {
        expect(text).toContain("00:00:00.000 --> 00:00:01.000");
        expect(text).toContain("00:00:01.000 --> 00:00:02.000");
        expect(text.match(/Hello episode/g)).toHaveLength(2);
      } else {
        expect(text).toContain("Arial");
        expect(text).toContain("{\\i1}Styled line");
        expect(text.match(/Styled line/g)).toHaveLength(2);
        expect(text).toContain("0:00:02.00");
      }
      expect(extract).toHaveBeenCalledTimes(2);
      await service.compose("embedded-cut", track.id, track.extension);
      expect(extract).toHaveBeenCalledTimes(2);
      // Private snapshots retain lazy extraction descriptors for recovery after restart.
      const persistence = new SessionPersistence(
        path.join(directory, `snapshots-${extension}`),
        {
          loadPlaylist: () => Promise.reject(Error("unused")),
          createResource: () => {
            throw Error("unused");
          },
        },
      );
      persistence.save(store.get("embedded-cut")!);
      const restored = persistence.restore(Date.now());
      expect(
        restored[0]?.subtitleTracks.get(track.id)?.sources[0]?.embedded
          ?.streamIndex,
      ).toBe(1);
    },
  );
  it("exposes embedded tracks alongside external families, supports opting out, and hides process URLs", async () => {
    const reader = new EmbeddedSubtitleService();
    const discover = vi.spyOn(reader, "discover");
    const store = new CutSessionStore();
    session(store);
    const input = selection();
    for (const episode of input.episodes)
      (episode as { subtitles: unknown[] }).subtitles = [
        {
          id: "eng",
          lang: "eng",
          source: "stream",
          url: `https://subtitles.test/${episode.episodeId}.srt`,
        },
      ];
    const both = await new SubtitleService(
      createSubtitleConfig(),
      store,
      undefined,
      undefined,
      reader,
    ).discover("embedded-cut", input);
    expect(both).toHaveLength(2);
    expect(discover).toHaveBeenCalledTimes(2);
    discover.mockClear();
    await new SubtitleService(
      createSubtitleConfig({ embeddedEnabled: false }),
      store,
      undefined,
      undefined,
      reader,
    ).discover("embedded-cut", selection());
    expect(discover).not.toHaveBeenCalled();
    expect(
      await reader.discover({ ...source(), url: `${origin}/broken` }),
    ).toEqual([]);
    await expect(
      reader.extract(
        { ...source(), url: `${origin}/broken` },
        { streamIndex: 1, format: "srt" },
      ),
    ).rejects.toThrow(/^embedded_subtitle_extraction_failed$/);
    expect(
      await reader.discover({ ...source(), url: "file:///etc/passwd" }),
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      reader.discover(source(), controller.signal),
    ).rejects.toThrow();
  });
});
