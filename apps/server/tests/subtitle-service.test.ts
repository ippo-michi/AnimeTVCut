import { describe, expect, it } from "vitest";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import { createSubtitleConfig } from "../src/services/subtitle-config.js";
import { SafeSubtitleFetcher } from "../src/services/subtitle-fetcher.js";
import { SubtitleService } from "../src/services/subtitle-service.js";
import type { CandidateFamilySelection } from "../src/services/stremio-upstream/types.js";
import type { StremioUpstreamClient } from "../src/services/stremio-upstream/client.js";

function saveSession(store: CutSessionStore, id = "cut") {
  return store.save({
    id,
    duration: 10,
    playlist: "#EXTM3U",
    pieces: [
      {
        id: "p",
        sourceEpisodeId: "e1",
        sourceStart: 0,
        sourceEnd: 10,
        outputStart: 0,
        outputEnd: 10,
        kind: "content",
      },
    ],
    appliedCuts: [],
    resources: new Map(),
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
    outputSkipSegments: [],
    outputSkipDiagnostics: [],
  });
}
describe("subtitle session behavior", () => {
  it("keeps attached subtitles when the optional subtitle resource fails", async () => {
    const store = new CutSessionStore(1000);
    saveSession(store);
    const upstream = {
      getSubtitles: async () => {
        throw new Error("private signed URL");
      },
    } as unknown as StremioUpstreamClient;
    const service = new SubtitleService(
      createSubtitleConfig(),
      store,
      upstream,
    );
    const selection = {
      familyMethod: "binge_group",
      familyKey: "x",
      unsupported: {
        torrent: 0,
        usenet: 0,
        archive: 0,
        youtube: 0,
        external: 0,
        unsupported: 0,
      },
      warnings: [],
      episodes: [
        {
          episodeId: "e1",
          upstreamType: "series",
          upstreamVideoId: "opaque",
          upstreamRank: 0,
          familyMethod: "binge_group",
          familyKey: "x",
          mediaSource: {
            kind: "http_media",
            episodeId: "e1",
            url: "https://media.test/e.mkv",
            headers: {},
          },
          videoHash: "hash",
          subtitles: [
            {
              id: "eng",
              lang: "eng",
              url: "https://subs.test/e.srt",
              source: "stream",
            },
          ],
        },
      ],
    } as CandidateFamilySelection;
    expect(await service.discover("cut", selection)).toHaveLength(1);
    expect(JSON.stringify(service.diagnostics("cut"))).not.toContain(
      "subs.test",
    );
  });
  it("leaves the video session valid after subtitle parse failure and expires tracks with it", async () => {
    const store = new CutSessionStore(1000);
    const session = saveSession(store);
    store.attachSubtitles(
      "cut",
      [
        {
          id: "sub01",
          lang: "eng",
          familyMethod: "exact_id",
          outputFormat: "webvtt",
          state: "lazy",
          sources: [
            {
              episodeId: "e1",
              subtitleId: "eng",
              url: "https://subs.test/bad.srt",
              formatHint: "srt",
            },
          ],
        },
      ],
      { discoveredPerEpisode: { e1: 1 }, issues: [] },
    );
    const fetcher = new SafeSubtitleFetcher(
      createSubtitleConfig({ allowedOrigins: ["https://subs.test"] }),
      async () => new Response("not a subtitle"),
    );
    const service = new SubtitleService(
      createSubtitleConfig(),
      store,
      undefined,
      fetcher,
    );
    await expect(service.compose("cut", "sub01", "vtt")).rejects.toThrow(
      "unsupported_format",
    );
    expect(store.get("cut", session.createdAt + 500)).toBeDefined();
    expect(store.get("cut", session.expiresAt)).toBeUndefined();
  });
});

it("aligns Jimaku dialogue to the embedded reference before mapping the cut", async () => {
  const store = new CutSessionStore();
  store.save({
    id: "jcut",
    duration: 40,
    playlist: "#EXTM3U",
    resources: new Map(),
    appliedCuts: [],
    pieces: [
      {
        id: "p",
        sourceEpisodeId: "e1",
        sourceStart: 10,
        sourceEnd: 50,
        outputStart: 0,
        outputEnd: 40,
        kind: "content",
      },
    ],
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
    outputSkipSegments: [],
    outputSkipDiagnostics: [],
  });
  const timestamp = (time: number) => {
    const minutes = Math.floor(time / 60),
      seconds = Math.floor(time % 60),
      millis = Math.round((time % 1) * 1000);
    return `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  };
  const srt = (shift: number) =>
    Array.from({ length: 30 }, (_, i) => {
      const start = 3 + i * 3.5 + (i % 4) * 0.6 + shift;
      return `${i + 1}\n${timestamp(start)} --> ${timestamp(start + 1.2)}\nline ${i}\n`;
    }).join("\n");
  const embedded = {
    discover: async () => [
      {
        streamIndex: 1,
        lang: "eng",
        format: "srt" as const,
        key: "eng:srt:0:0:dialogue",
      },
    ],
    extract: async () => ({
      bytes: new TextEncoder().encode(srt(0)),
      contentType: "application/x-subrip",
    }),
  };
  const fetcher = new SafeSubtitleFetcher(
    createSubtitleConfig(),
    async () =>
      new Response(srt(4), {
        headers: { "content-type": "application/x-subrip" },
      }),
    async () => [{ address: "8.8.8.8", family: 4 }] as never,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("search")
      ? Response.json([{ id: 1, name: "Example Show" }])
      : Response.json([
          { name: "Example Show - 01.srt", url: "https://jimaku.cc/01.srt" },
        ]);
  try {
    const service = new SubtitleService(
      createSubtitleConfig({ jimakuApiKey: "secret" }),
      store,
      undefined,
      fetcher,
      embedded,
    );
    const selection = {
      familyMethod: "binge_group",
      familyKey: "x",
      warnings: [],
      unsupported: {
        torrent: 0,
        usenet: 0,
        archive: 0,
        youtube: 0,
        external: 0,
        unsupported: 0,
      },
      episodes: [
        {
          episodeId: "e1",
          upstreamType: "series",
          upstreamVideoId: "e1",
          upstreamRank: 0,
          familyMethod: "binge_group",
          familyKey: "x",
          mediaSource: {
            kind: "http_media",
            episodeId: "e1",
            url: "https://media.test/e.mkv",
            headers: {},
          },
          subtitles: [],
        },
      ],
    } as CandidateFamilySelection;
    const tracks = await service.discover("jcut", selection, undefined, {
      title: "Example Show",
      episodes: [{ sourceEpisodeId: "e1", season: 1, episode: 1 }],
    });
    const japanese = tracks.find((track) => track.lang === "jpn")!;
    const result = await service.compose(
      "jcut",
      japanese.id,
      japanese.extension,
    );
    const output = new TextDecoder().decode(result!.bytes);
    expect(output).toContain("00:00:01.200 --> 00:00:02.400");
    expect(JSON.stringify(service.diagnostics("jcut"))).toContain("aligned:-4");
    expect(JSON.stringify(service.diagnostics("jcut"))).not.toContain("secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
