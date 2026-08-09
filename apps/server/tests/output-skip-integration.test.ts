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
  it("uses actual preserve-content alignment and retains no-safe-segment media", async () => {
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
    expect(response.json()).toMatchObject({
      version: 1,
      duration: 30,
      segments: [
        {
          type: "intro",
          start: 7,
          end: 11,
          reason: "alignment_retained",
        },
      ],
    });
    expect(response.body).not.toContain("secret-provider");
    await app.close();
  });

  it("publishes only the retained fragments around the applied aligned cut", async () => {
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
    expect(publicResponse.json().segments).toEqual([
      {
        id: "s01",
        type: "intro",
        start: 5,
        end: 7,
        title: "Skip Intro",
        reason: "partially_retained",
      },
    ]);
    const diagnostic = await app.inject({
      method: "GET",
      url: `/api/v1/dev/cuts/${cut.cutId}/segments`,
    });
    expect(diagnostic.json()).toMatchObject({
      sourceSegments: 1,
      outputSegments: 1,
      relationships: [
        {
          sourceIndex: 0,
          sourceStart: 5,
          sourceEnd: 13,
          removalRequested: true,
          retainedFragments: 1,
          outputRanges: [{ start: 5, end: 7 }],
        },
      ],
    });
    await app.close();
  });

  it("keeps one intro and one outro for the normal three-episode TV policy", async () => {
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
    expect(sessions.get(cut.cutId)?.outputSkipSegments).toEqual([
      {
        id: "s01",
        type: "intro",
        start: 0,
        end: 6,
        title: "Skip Intro",
        reason: "policy_kept",
      },
      {
        id: "s02",
        type: "outro",
        start: 60,
        end: 66,
        title: "Skip Outro",
        reason: "policy_kept",
      },
    ]);
  });

  it("never emits unsafe or ambiguously overlapping canonical ranges", async () => {
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
    expect(sessions.get(cut.cutId)?.outputSkipSegments).toEqual([]);
    expect(sessions.get(cut.cutId)?.outputSkipDiagnostics).toEqual([
      expect.objectContaining({ status: "conflict_omitted" }),
      expect.objectContaining({ status: "conflict_omitted" }),
    ]);
  });
});
