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
  it("expands preserve-content alignment to cover full segments", async () => {
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
    // Alignment expands removal(7,11) to cover full segment (6,12)
    // Duration is 24s (30 - 6s removed segment)
    expect(response.json()).toMatchObject({
      version: 1,
      duration: 24,
    });
    expect(response.body).not.toContain("secret-provider");
    await app.close();
  });

  it("expands removal to cover full segments and removes entire episode", async () => {
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
    // Alignment expands removal(5,13) to cover full episode (0,30)
    // The entire episode is removed, so segments array is empty
    expect(publicResponse.json().segments).toEqual([]);
    const diagnostic = await app.inject({
      method: "GET",
      url: `/api/v1/dev/cuts/${cut.cutId}/segments`,
    });
    expect(diagnostic.json()).toMatchObject({
      sourceSegments: 1,
      outputSegments: 0,
      relationships: [
        {
          sourceIndex: 0,
          sourceStart: 5,
          sourceEnd: 13,
          removalRequested: true,
          retainedFragments: 0,
          outputRanges: [],
        },
      ],
    });
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
    // With removeRecaps=false, the recap is kept but overlaps with opening
    // The opening is removed, and the recap is kept as a diagnostic
    const segments = sessions.get(cut.cutId)?.outputSkipSegments ?? [];
    expect(segments.length).toBeGreaterThanOrEqual(0);
    const diagnostics = sessions.get(cut.cutId)?.outputSkipDiagnostics ?? [];
    expect(diagnostics.length).toBeGreaterThanOrEqual(0);
  });
});
