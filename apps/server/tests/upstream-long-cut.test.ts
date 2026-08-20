import type { EpisodeSkipResolution } from "@animetvcut/skip-providers";
import { describe, expect, it, vi } from "vitest";

import type {
  CutService,
  PreparedInputSource,
} from "../src/services/cut-service.js";
import { PreparedSourceError } from "../src/services/cut-service.js";
import type { MediaInputSource } from "../src/services/hls-source-loader.js";
import { MediaFlowSourceError } from "../src/services/mediaflow/errors.js";
import type {
  EpisodeSkipLookupRequest,
  SkipService,
} from "../src/services/skip-service.js";
import type {
  CandidateFamilySelection,
  EpisodeSourceResolver,
  UpstreamEpisodeReference,
} from "../src/services/stremio-upstream/types.js";
import {
  UpstreamCutService,
  isStructurallyPlausibleEpisodeDuration,
} from "../src/services/upstream-cut-service.js";

function selection(episodeId: string): CandidateFamilySelection {
  return {
    familyMethod: "binge_group",
    familyKey: `private-${episodeId}`,
    episodes: [
      {
        episodeId,
        upstreamType: "series",
        upstreamVideoId: episodeId,
        upstreamRank: 0,
        familyMethod: "binge_group",
        familyKey: `private-${episodeId}`,
        mediaSource: {
          kind: "http_media",
          episodeId,
          url: `https://media.test/${episodeId}.mkv`,
          headers: {},
        },
        subtitles: [],
      },
    ],
    unsupported: {
      torrent: 0,
      usenet: 0,
      archive: 0,
      youtube: 0,
      external: 0,
      unsupported: 0,
    },
    warnings: [],
  };
}

function rankedSelection(
  episodeId: string,
  rank: number,
): CandidateFamilySelection {
  const base = selection(episodeId);
  return {
    ...base,
    episodes: base.episodes.map((episode) => ({
      ...episode,
      upstreamRank: rank,
    })),
  };
}

function multiSelection(
  episodeIds: readonly string[],
  ranks: readonly number[],
): CandidateFamilySelection {
  const base = selection(episodeIds[0]!);
  return {
    ...base,
    familyKey: "shared",
    episodes: episodeIds.map((episodeId, index) => ({
      ...base.episodes[0]!,
      episodeId,
      upstreamVideoId: episodeId,
      upstreamRank: ranks[index] ?? 0,
      familyKey: "shared",
      mediaSource: {
        ...base.episodes[0]!.mediaSource,
        episodeId,
        url: `https://media.test/${episodeId}-${ranks[index] ?? 0}.mkv`,
      },
    })),
  };
}

describe("long-cut upstream orchestration", () => {
  it("accepts a movie-length premiere without trusting uniform series runtime", () => {
    expect(isStructurallyPlausibleEpisodeDuration(4_920)).toBe(true);
    expect(isStructurallyPlausibleEpisodeDuration(1_440)).toBe(true);
    expect(isStructurallyPlausibleEpisodeDuration(59)).toBe(false);
    expect(isStructurallyPlausibleEpisodeDuration(12 * 60 * 60 + 1)).toBe(
      false,
    );
    expect(isStructurallyPlausibleEpisodeDuration(120, 1_440)).toBe(false);
    expect(isStructurallyPlausibleEpisodeDuration(360, 1_440)).toBe(true);
    expect(isStructurallyPlausibleEpisodeDuration(4_920, 1_440)).toBe(true);
  });

  it("bounds per-season selection and prepares every chosen playlist once", async () => {
    let active = 0;
    let maxActive = 0;
    const resolveEpisodes = vi.fn(
      async (
        episodes: readonly UpstreamEpisodeReference[],
      ): Promise<CandidateFamilySelection> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return selection(episodes[0]!.episodeId);
      },
    );
    const resolver: EpisodeSourceResolver = { resolve: resolveEpisodes };
    const prepareSources = vi.fn(
      async (
        sources: readonly MediaInputSource[],
      ): Promise<PreparedInputSource[]> =>
        sources.map((source) => ({
          source,
          playlist: {
            sourceUrl: `fixture://${source.episodeId}`,
            targetDuration: 1,
            mediaSequence: 0,
            duration: 1,
            independentSegments: true,
            segments: [],
          },
        })),
    );
    const cutService = {
      prepareSources,
      attachOutputSkipSegments: vi.fn(),
      createCutFromPreparedSources: vi.fn(() => ({
        cutId: "cut",
        duration: 4,
        playlistUrl: "/media/cut/cut/master.m3u8",
        pieces: [],
        appliedCuts: [],
      })),
    } as unknown as CutService;
    const resolveSkips = vi.fn(
      async (
        requests: readonly EpisodeSkipLookupRequest[],
      ): Promise<EpisodeSkipResolution[]> =>
        requests.map((request) => ({
          episodeId: request.reference.episodeId,
          identity: {},
          durationSeconds: 1,
          providers: [],
          segments: [],
          warnings: [],
        })),
    );
    const skipService = { resolve: resolveSkips } as unknown as SkipService;
    const service = new UpstreamCutService(resolver, cutService, skipService);
    const seasons = Array.from({ length: 4 }, (_, index) => ({
      season: index + 1,
      episodes: [
        {
          episodeId: `s${index + 1}e1`,
          type: "series",
          videoId: `s${index + 1}e1`,
        },
      ],
    }));
    const result = await service.createLongAutomaticCut({
      seasons,
      seasonConcurrency: 2,
      sourcePrepareConcurrency: 3,
    });
    expect(maxActive).toBe(2);
    expect(resolveEpisodes).toHaveBeenCalledTimes(4);
    expect(prepareSources).toHaveBeenCalledTimes(1);
    expect(prepareSources.mock.calls[0]?.[0]).toHaveLength(4);
    expect(prepareSources.mock.calls[0]?.[1]).toMatchObject({
      concurrency: 3,
    });
    expect(result.families.map((item) => item.season)).toEqual([1, 2, 3, 4]);
  });

  it("retries long cuts with alternate candidates after a MediaFlow source failure", async () => {
    const resolveEpisodes = vi.fn(
      async (
        episodes: readonly UpstreamEpisodeReference[],
        options?: { excludedCandidates?: ReadonlySet<string> },
      ): Promise<CandidateFamilySelection> =>
        rankedSelection(
          episodes[0]!.episodeId,
          options?.excludedCandidates?.has(`${episodes[0]!.episodeId}:0`)
            ? 1
            : 0,
        ),
    );
    const resolver: EpisodeSourceResolver = { resolve: resolveEpisodes };
    let prepareAttempts = 0;
    const prepareSources = vi.fn(
      async (
        sources: readonly MediaInputSource[],
      ): Promise<PreparedInputSource[]> => {
        prepareAttempts += 1;
        if (prepareAttempts === 1) {
          throw new MediaFlowSourceError("candidate expired");
        }
        return sources.map((source) => ({
          source,
          playlist: {
            sourceUrl: `fixture://${source.episodeId}`,
            targetDuration: 1,
            mediaSequence: 0,
            duration: 1,
            independentSegments: true,
            segments: [],
          },
        }));
      },
    );
    const cutService = {
      prepareSources,
      attachOutputSkipSegments: vi.fn(),
      createCutFromPreparedSources: vi.fn(() => ({
        cutId: "cut",
        duration: 1,
        playlistUrl: "/media/cut/cut/master.m3u8",
        pieces: [],
        appliedCuts: [],
      })),
    } as unknown as CutService;
    const skipService = {
      resolve: vi.fn(async (requests: readonly EpisodeSkipLookupRequest[]) =>
        requests.map((request) => ({
          episodeId: request.reference.episodeId,
          identity: {},
          durationSeconds: 1,
          providers: [],
          segments: [],
          warnings: [],
        })),
      ),
    } as unknown as SkipService;
    const service = new UpstreamCutService(resolver, cutService, skipService);

    const result = await service.createLongAutomaticCut({
      seasons: [
        {
          season: 1,
          episodes: [{ episodeId: "ep1", type: "series", videoId: "ep1" }],
        },
      ],
      seasonConcurrency: 1,
    });

    expect(resolveEpisodes).toHaveBeenCalledTimes(2);
    expect(prepareSources).toHaveBeenCalledTimes(2);
    expect(result.selection.episodes[0]?.rank).toBe(1);
  });

  it("only excludes the failed episode candidate during a multi-episode retry", async () => {
    const resolveEpisodes = vi.fn(
      async (
        episodes: readonly UpstreamEpisodeReference[],
        options?: { excludedCandidates?: ReadonlySet<string> },
      ): Promise<CandidateFamilySelection> =>
        multiSelection(
          episodes.map(({ episodeId }) => episodeId),
          episodes.map(({ episodeId }) =>
            options?.excludedCandidates?.has(`${episodeId}:0`) ? 1 : 0,
          ),
        ),
    );
    const resolver: EpisodeSourceResolver = { resolve: resolveEpisodes };
    let prepareAttempts = 0;
    const prepareSources = vi.fn(
      async (
        sources: readonly MediaInputSource[],
      ): Promise<PreparedInputSource[]> => {
        prepareAttempts += 1;
        if (prepareAttempts === 1)
          throw new PreparedSourceError(
            "ep1",
            new MediaFlowSourceError("candidate expired"),
          );
        return sources.map((source) => ({
          source,
          playlist: {
            sourceUrl: `fixture://${source.episodeId}`,
            targetDuration: 1,
            mediaSequence: 0,
            duration: 1,
            independentSegments: true,
            segments: [],
          },
        }));
      },
    );
    const cutService = {
      prepareSources,
      attachOutputSkipSegments: vi.fn(),
      createCutFromPreparedSources: vi.fn(() => ({
        cutId: "cut",
        duration: 2,
        playlistUrl: "/media/cut/cut/master.m3u8",
        pieces: [],
        appliedCuts: [],
      })),
    } as unknown as CutService;
    const skipService = {
      resolve: vi.fn(async (requests: readonly EpisodeSkipLookupRequest[]) =>
        requests.map((request) => ({
          episodeId: request.reference.episodeId,
          identity: {},
          durationSeconds: 1,
          providers: [],
          segments: [],
          warnings: [],
        })),
      ),
    } as unknown as SkipService;
    const service = new UpstreamCutService(resolver, cutService, skipService);

    const result = await service.createLongAutomaticCut({
      seasons: [
        {
          season: 1,
          episodes: [
            { episodeId: "ep1", type: "series", videoId: "ep1" },
            { episodeId: "ep2", type: "series", videoId: "ep2" },
          ],
        },
      ],
      seasonConcurrency: 1,
    });

    expect(resolveEpisodes).toHaveBeenCalledTimes(2);
    expect(resolveEpisodes.mock.calls[1]?.[1]).toMatchObject({
      excludedCandidates: new Set(["ep1:0"]),
    });
    expect(result.selection.episodes.map((episode) => episode.rank)).toEqual([
      1, 0,
    ]);
  });
});
