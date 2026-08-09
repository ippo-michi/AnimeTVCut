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
