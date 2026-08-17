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

      // Opening [0, 6) → applied [0, 6) → duration = 24s.
      expect(cut.duration).toBe(24);

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

      // ED [24, 30) → applied [24, 30). Preview [28, 30) merged → applied [24, 30).
      // Duration = 30 - 6 = 24s.
      expect(cut.duration).toBe(24);

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

  describe("CASE C — resolved preview to EOF", () => {
    it("removes a resolved preview through the end of the episode", async () => {
      const { service } = harness(() => [
        {
          type: "preview",
          start: 27,
          end: 30,
          provider: "aniskip",
          automaticRemoval: true,
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [reference("ep1")],
        cutPolicy: { removePreviews: true },
      });

      expect(cut.duration).toBe(27);
      expect(cut.pieces.at(-1)?.sourceEnd).toBe(27);
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
          start: 22,
          end: 27,
          provider: "fixture",
          automaticRemoval: true,
        },
        {
          type: "preview",
          start: 27,
          end: 30,
          provider: "fixture",
          automaticRemoval: true,
        },
      ]);
      const cut = await service.createAutomaticCut({
        episodes: [reference("ep1"), reference("ep2"), reference("ep3")],
        cutPolicy: {
          openings: "remove_all",
          endings: "remove_all",
          removePreviews: true,
        },
      });

      // Each episode retains [6,22): OP + ED + preview are gone.
      expect(cut.duration).toBeCloseTo(48, 1);

      const firstEpApplied = cut.appliedCuts.filter(
        (c) => c.episodeId === "ep1" && c.type === "opening",
      );
      expect(firstEpApplied).toHaveLength(1);
      expect(firstEpApplied[0].status).toBe("applied");

      const lastEpApplied = cut.appliedCuts.filter(
        (c) => c.episodeId === "ep3" && c.type === "ending",
      );
      expect(lastEpApplied).toHaveLength(1);
      expect(lastEpApplied[0].status).toBe("applied");

      for (const episodeId of ["ep1", "ep2", "ep3"]) {
        const retained = cut.pieces.filter(
          (piece) => piece.sourceEpisodeId === episodeId,
        );
        expect(retained).toHaveLength(1);
        expect(retained[0]).toMatchObject({ sourceStart: 6, sourceEnd: 22 });
      }
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

    // Opening [5, 13) → applied [5, 13) → duration = 30 - 8 = 22s.
    // NOT 0 (which would indicate entire episode deleted).
    expect(cut.duration).toBe(22);
    expect(cut.pieces.length).toBeGreaterThan(0);

    const applied = cut.appliedCuts[0];
    expect(applied.status).toBe("applied");
    // Applied range is exact
    expect(applied.appliedStart).toBe(5);
    expect(applied.appliedEnd).toBe(13);
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

    const sourceStarts = cut.pieces.map((p) => p.sourceStart);
    const sourceEnds = cut.pieces.map((p) => p.sourceEnd);

    expect(sourceStarts).toContain(0);
    expect(sourceEnds).toContain(30);
  });
});
