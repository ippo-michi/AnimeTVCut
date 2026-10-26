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
  it("retains complete external families, supports opting out, and fails without leaking process URLs", async () => {
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
    await new SubtitleService(
      createSubtitleConfig(),
      store,
      undefined,
      undefined,
      reader,
    ).discover("embedded-cut", input);
    expect(discover).not.toHaveBeenCalled();
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
