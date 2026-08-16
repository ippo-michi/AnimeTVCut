import path from "node:path";

import type { EpisodeSkipResolution } from "@animetvcut/skip-providers";
import { describe, expect, it } from "vitest";

import { CutService } from "../src/services/cut-service.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import { FixtureSourceLoader } from "../src/services/fixture-source.js";
import type {
  EpisodeSkipLookupRequest,
  SkipService,
} from "../src/services/skip-service.js";
import type {
  CandidateFamilySelection,
  EpisodeSourceResolver,
  UpstreamEpisodeReference,
} from "../src/services/stremio-upstream/types.js";
import { UpstreamCutService } from "../src/services/upstream-cut-service.js";

const fixtureRoot = path.resolve("fixtures/hls");

function harness(
  segmentFactory: (
    request: EpisodeSkipLookupRequest,
  ) => EpisodeSkipResolution["segments"],
) {
  const sessions = new CutSessionStore();
  const cutService = new CutService(
    new FixtureSourceLoader(fixtureRoot),
    sessions,
  );
  const resolver: EpisodeSourceResolver = {
    resolve: async (
      episodes: readonly UpstreamEpisodeReference[],
    ): Promise<CandidateFamilySelection> => ({
      familyMethod: "binge_group",
      familyKey: "fixture-family",
      episodes: episodes.map((episode, index) => ({
        episodeId: episode.episodeId,
        upstreamType: episode.type,
        upstreamVideoId: episode.videoId,
        upstreamRank: 0,
        familyMethod: "binge_group",
        familyKey: "fixture-family",
        mediaSource: {
          kind: "fixture_hls",
          episodeId: episode.episodeId,
          playlistUrl: `fixture://episode${index + 1}`,
        },
        subtitles: [],
      })),
      unsupported: {
        torrent: 0,
        usenet: 0,
        archive: 0,
        youtube: 0,
        external: 0,
        unsupported: 0,
      },
      warnings: [],
    }),
  };
  const skipService = {
    resolve: async (requests: readonly EpisodeSkipLookupRequest[]) =>
      requests.map((request) => ({
        episodeId: request.reference.episodeId,
        identity: {},
        durationSeconds: request.durationSeconds,
        providers: [],
        segments: segmentFactory(request),
        warnings: [],
      })),
  } as unknown as SkipService;
  return {
    sessions,
    service: new UpstreamCutService(resolver, cutService, skipService),
  };
}

function reference(episodeId: string): UpstreamEpisodeReference {
  return { episodeId, type: "series", videoId: episodeId };
}

describe("full-skip end-to-end tests", () => {
  describe("CASE A — opening removal", () => {
    it("removes opening that aligns with segment boundaries", async () => {
      const { sessions, service } = harness(() => [
        {
          type: "opening",
          start: 0,
          end: 6,
          provider: "aniskip",
          automaticRemoval: true,
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [reference("ep1")],
        cutPolicy: { openings: "remove_all" },
      });

      // Opening [0, 6) fully contains segment [0, 6). Removed.
      // Duration = 30 - 6 = 24s.
      expect(cut.duration).toBe(24);

      // Verify the opening is fully removed
      const diagnostics = sessions.get(cut.cutId)?.outputSkipDiagnostics ?? [];
      const openingDiag = diagnostics.find(
        (d: { type: string }) => d.type === "intro",
      );
      expect(openingDiag?.status).toBe("fully_removed");
    });
  });

  describe("CASE B — ED + preview merge", () => {
    it("merges ED and preview into contiguous removal at episode end", async () => {
      const { sessions, service } = harness(() => [
        {
          type: "ending",
          start: 24,
          end: 30,
          provider: "aniskip",
          automaticRemoval: true,
        },
        {
          type: "preview",
          start: 28,
          end: 30,
          provider: "aniskip",
          automaticRemoval: true,
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [reference("ep1")],
        cutPolicy: { endings: "remove_all", removePreviews: true },
      });

      // ED [24, 30) fully contains segment [24, 30). Preview [28, 30) is
      // merged with ED. Duration = 30 - 6 = 24s.
      expect(cut.duration).toBe(24);

      // Both ED and preview should be fully removed
      const diagnostics = sessions.get(cut.cutId)?.outputSkipDiagnostics ?? [];
      const edDiag = diagnostics.find(
        (d: { type: string }) => d.type === "outro",
      );
      const previewDiag = diagnostics.find(
        (d: { type: string }) => d.type === "preview",
      );
      expect(edDiag?.status).toBe("fully_removed");
      expect(previewDiag?.status).toBe("fully_removed");
    });
  });

  describe("CASE C — preview open-ended", () => {
    it("handles open-ended preview at end of episode", async () => {
      const { service } = harness(() => [
        {
          type: "preview",
          start: 27,
          end: null,
          provider: "aniskip",
          automaticRemoval: true,
          unsafeReason: "open_ended",
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [reference("ep1")],
        cutPolicy: { removePreviews: true },
      });

      // Open-ended preview [27, null) is estimated. The estimated range
      // overlaps with segment [24, 30) but doesn't fully contain it.
      // preserve_content removes nothing for this case.
      // The key assertion: the pipeline doesn't crash and produces a valid cut.
      expect(cut.duration).toBeGreaterThan(0);
    });
  });

  describe("CASE D — 3 episodes with remove_all", () => {
    it("removes OP/ED/preview from every episode", async () => {
      const { service } = harness(() => [
        {
          type: "opening",
          start: 0,
          end: 6,
          provider: "fixture",
          automaticRemoval: true,
        },
        {
          type: "ending",
          start: 24,
          end: 30,
          provider: "fixture",
          automaticRemoval: true,
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [
          reference("ep1"),
          reference("ep2"),
          reference("ep3"),
        ],
        cutPolicy: { openings: "remove_all", endings: "remove_all" },
      });

      // Each episode: 30 - 6 (OP) - 6 (ED) = 18s
      // Total: 18 * 3 = 54s
      expect(cut.duration).toBeCloseTo(54, 1);

      // Verify first episode OP removed
      const firstEpApplied = cut.appliedCuts.filter(
        (c) => c.episodeId === "ep1" && c.type === "opening",
      );
      expect(firstEpApplied).toHaveLength(1);
      expect(firstEpApplied[0].status).toBe("applied");

      // Verify last episode ED removed
      const lastEpApplied = cut.appliedCuts.filter(
        (c) => c.episodeId === "ep3" && c.type === "ending",
      );
      expect(lastEpApplied).toHaveLength(1);
      expect(lastEpApplied[0].status).toBe("applied");

      // All episodes should have OP and ED removed
      const allApplied = cut.appliedCuts.filter(
        (c) => c.status === "applied",
      );
      expect(allApplied).toHaveLength(6); // 3 episodes × 2 (OP + ED)
    });
  });
});

describe("regression: over-cutting must not delete full episode", () => {
  it("requested skip 5→13 must not delete entire episode", async () => {
    const { service } = harness(() => [
      {
        type: "opening",
        start: 5,
        end: 13,
        provider: "fixture",
        automaticRemoval: true,
      },
    ]);
    const cut = await service.createAutomaticCut({
      episodes: [reference("ep1")],
      cutPolicy: { openings: "remove_all" },
    });

    // Episode duration is 30s. With the bug, it would be 0 (entire episode
    // deleted). With the fix, only segment [6, 12) is removed → duration = 24s.
    expect(cut.duration).toBeGreaterThan(20);
    expect(cut.duration).toBeLessThan(30);

    // Verify retained pieces are not empty
    expect(cut.pieces.length).toBeGreaterThan(0);

    // The applied removal should only cover fully-contained segments
    const applied = cut.appliedCuts[0];
    expect(applied.status).toBe("applied");
    // With preserve_content, only [6, 12) is removed
    expect(applied.appliedStart).toBeGreaterThanOrEqual(6);
    expect(applied.appliedEnd).toBeLessThanOrEqual(12);
  });

  it("preserves content immediately before and after requested skip", async () => {
    const { service } = harness(() => [
      {
        type: "opening",
        start: 5,
        end: 13,
        provider: "fixture",
        automaticRemoval: true,
      },
    ]);
    const cut = await service.createAutomaticCut({
      episodes: [reference("ep1")],
      cutPolicy: { openings: "remove_all" },
    });

    // Retained content should include [0, 6) and [12, 30)
    // (or at least some content before and after the removal)
    const sourceStarts = cut.pieces.map((p) => p.sourceStart);
    const sourceEnds = cut.pieces.map((p) => p.sourceEnd);

    // Must have content starting at 0 (before the skip)
    expect(sourceStarts).toContain(0);

    // Must have content ending at 30 (after the skip)
    expect(sourceEnds).toContain(30);
  });
});
