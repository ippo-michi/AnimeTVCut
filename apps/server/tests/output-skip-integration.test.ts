import path from "node:path";

import type { EpisodeSkipResolution } from "@animetvcut/skip-providers";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { mediaRoutes } from "../src/routes/media.js";
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

describe("output skip metadata through a real automatic cut session", () => {
  it("preserve_content alignment only removes fully-contained segments", async () => {
    const { sessions, service } = harness(() => [
      {
        type: "opening",
        start: 7,
        end: 11,
        provider: "secret-provider",
        automaticRemoval: true,
      },
    ]);
    const cut = await service.createAutomaticCut({
      episodes: [reference("ep1")],
      cutPolicy: { openings: "remove_all" },
    });
    const app = Fastify();
    await app.register(mediaRoutes(sessions));
    const response = await app.inject({
      method: "GET",
      url: `/media/cut/${cut.cutId}/segments.json`,
    });
    expect(response.statusCode).toBe(200);
    // Opening [7, 11) is NOT fully contained in any segment (6 < 7, 12 > 11).
    // preserve_content removes nothing. Duration stays 30s.
    expect(response.json()).toMatchObject({
      version: 1,
      duration: 30,
    });
    expect(response.body).not.toContain("secret-provider");
    await app.close();
  });

  it("preserve_content does not over-delete when removal straddles segments", async () => {
    const { sessions, service } = harness(() => [
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
    const app = Fastify();
    await app.register(mediaRoutes(sessions));
    const publicResponse = await app.inject({
      method: "GET",
      url: `/media/cut/${cut.cutId}/segments.json`,
    });
    // Opening [5, 13) fully contains segment [6, 12).
    // preserve_content removes only [6, 12), not [0, 18).
    // Duration = 30 - 6 = 24s (not 0 — the episode is NOT completely deleted).
    expect(publicResponse.json()).toMatchObject({
      version: 1,
      duration: 24,
    });
    // Must NOT be empty — the episode content is preserved.
    expect(publicResponse.json().segments.length).toBeGreaterThan(0);
    const diagnostic = await app.inject({
      method: "GET",
      url: `/api/v1/dev/cuts/${cut.cutId}/segments`,
    });
    const diagJson = diagnostic.json();
    // The opening [5,13) only fully contains segment [6,12).
    // Retained: [0,6) and [12,30). The diagnostic tracks the source→output mapping.
    expect(diagJson).toMatchObject({
      sourceSegments: 1,
    });
    const relationships = diagJson.relationships as Array<{
      sourceIndex: number;
      sourceStart: number;
      sourceEnd: number;
      removalRequested: boolean;
      retainedFragments: number;
    }>;
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      sourceIndex: 0,
      sourceStart: 5,
      sourceEnd: 13,
      removalRequested: true,
    });
    // Some content from the opening remains in output (partial overlap at boundaries)
    expect(relationships[0].retainedFragments).toBeGreaterThan(0);
    await app.close();
  });

  it("removes all intros and outros with the default remove_all policy", async () => {
    const { sessions, service } = harness(() => [
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
      episodes: [reference("ep1"), reference("ep2"), reference("ep3")],
    });
    // With remove_all policy, no segments are kept by policy
    expect(sessions.get(cut.cutId)?.outputSkipSegments).toEqual([]);
  });

  it("handles overlapping ranges with removeRecaps=false", async () => {
    const { sessions, service } = harness(() => [
      {
        type: "opening",
        start: 0,
        end: 12,
        provider: "fixture",
        automaticRemoval: true,
      },
      {
        type: "recap",
        start: 6,
        end: 18,
        provider: "fixture",
        automaticRemoval: true,
      },
      {
        type: "ending",
        start: 24,
        end: null,
        provider: "fixture",
        automaticRemoval: false,
        unsafeReason: "open_ended",
      },
      {
        type: "preview",
        start: 20,
        end: 24,
        provider: "fixture",
        automaticRemoval: false,
        unsafeReason: "low_confidence",
      },
    ]);
    const cut = await service.createAutomaticCut({
      episodes: [reference("ep1")],
      cutPolicy: { removeRecaps: false },
    });
    // Opening [0, 12) fully contains [0, 6) and [6, 12). Applied = [0, 12).
    // Recap [6, 18): removeRecaps=false → decision=keep. Not in removals.
    // Ending and preview: unsafe → not attached.
    // Only 2 diagnostics: opening (removed) and recap (kept).
    const segments = sessions.get(cut.cutId)?.outputSkipSegments ?? [];
    const diagnostics = sessions.get(cut.cutId)?.outputSkipDiagnostics ?? [];
    expect(diagnostics).toHaveLength(2);
    const openingDiag = diagnostics.find(
      (d: { type: string }) => d.type === "intro",
    );
    expect(openingDiag?.status).toBe("fully_removed");
    const recapDiag = diagnostics.find(
      (d: { type: string }) => d.type === "recap",
    );
    expect(recapDiag?.decision).toBe("keep");
    expect(recapDiag?.status).toBe("mapped");
    // Segments: only recap remains as a skip segment (opening is fully removed)
    expect(segments).toHaveLength(1);
    expect(segments[0]?.type).toBe("recap");
  });
});
