import { describe, expect, it } from "vitest";

import {
  buildAutomaticCutPlan,
  deriveSkipLookupIdentity,
  extractImdbSkipIdentity,
  mergeRemovalRanges,
  type EpisodeSkipResolution,
  type SkipSegment,
} from "../src/index.js";

function segment(
  type: SkipSegment["type"],
  start: number,
  end: number,
  overrides: Partial<SkipSegment> = {},
): SkipSegment {
  return {
    type,
    start,
    end,
    provider: "test",
    automaticRemoval: true,
    ...overrides,
  };
}

function episode(
  episodeId: string,
  segments: readonly SkipSegment[],
): EpisodeSkipResolution {
  return {
    episodeId,
    identity: {},
    durationSeconds: 30,
    providers: [],
    segments,
    warnings: [],
  };
}

describe("skip identity", () => {
  it("extracts a conservative IMDb series episode identity", () => {
    expect(extractImdbSkipIdentity("tt1234567:1:3")).toEqual({
      id: "tt1234567",
      season: 1,
      episode: 3,
    });
    expect(extractImdbSkipIdentity("tt12345678:12:34")).toEqual({
      id: "tt12345678",
      season: 12,
      episode: 34,
    });
  });

  it.each([
    "kitsu:12345:3",
    "anime:foo:12",
    "custom-series-id",
    "tt123:1:1",
    "tt1234567:0:1",
  ])("does not invent IMDb identity for %s", (videoId) => {
    expect(extractImdbSkipIdentity(videoId)).toBeUndefined();
  });

  it("adds an optional explicit MAL identity without mapping IMDb", () => {
    expect(
      deriveSkipLookupIdentity("custom:1", {
        malAnimeId: 52_991,
        malEpisode: 2,
      }),
    ).toEqual({ mal: { animeId: 52_991, episode: 2 } });
    expect(deriveSkipLookupIdentity("tt1234567:1:2")).not.toHaveProperty("mal");
  });

  it("accepts validated provider-only IMDb coordinates for opaque episode IDs", () => {
    expect(
      deriveSkipLookupIdentity("kitsu:7442:4", {
        imdbId: "tt2560140",
        imdbSeason: 1,
        imdbEpisode: 4,
      }),
    ).toEqual({ imdb: { id: "tt2560140", season: 1, episode: 4 } });
  });
});

describe("automatic cut policy", () => {
  const episodes = [
    episode("ep1", [
      segment("opening", 0, 6),
      segment("recap", 6, 8),
      segment("ending", 24, 28),
      segment("preview", 28, 30),
    ]),
    episode("ep2", [segment("opening", 0, 6), segment("ending", 24, 30)]),
    episode("ep3", [
      segment("opening", 0, 6),
      segment("recap", 6, 8),
      segment("ending", 24, 28),
      segment("preview", 28, 30),
    ]),
  ];

  it("keeps only the first episode opening and last episode ending", () => {
    const plan = buildAutomaticCutPlan(episodes);
    expect(
      plan.episodes.map((item) =>
        item.segments.map((reported) => [reported.type, reported.decision]),
      ),
    ).toEqual([
      [
        ["opening", "keep_first_opening"],
        ["recap", "remove"],
        ["ending", "remove"],
        ["preview", "remove"],
      ],
      [
        ["opening", "remove"],
        ["ending", "remove"],
      ],
      [
        ["opening", "remove"],
        ["recap", "remove"],
        ["ending", "keep_last_ending"],
        ["preview", "remove"],
      ],
    ]);
  });

  it("does not promote a later opening or earlier ending when the edge one is missing", () => {
    const plan = buildAutomaticCutPlan([
      episode("ep1", []),
      episode("ep2", [segment("opening", 0, 6), segment("ending", 24, 30)]),
      episode("ep3", []),
    ]);
    expect(plan.automaticRemovals).toEqual([
      { episodeId: "ep2", type: "opening", start: 0, end: 6 },
      { episodeId: "ep2", type: "ending", start: 24, end: 30 },
    ]);
  });

  it("never promotes unsafe segments into removals", () => {
    const plan = buildAutomaticCutPlan([
      episode("ep1", []),
      episode("ep2", [
        segment("opening", 0, 6, {
          automaticRemoval: false,
          unsafeReason: "mixed_content",
        }),
        {
          type: "ending",
          start: 24,
          end: null,
          provider: "test",
          automaticRemoval: false,
          unsafeReason: "open_ended",
        },
      ]),
      episode("ep3", []),
    ]);
    expect(plan.automaticRemovals).toEqual([]);
    expect(plan.episodes[1]!.segments.map((item) => item.decision)).toEqual([
      "unsafe_ignored",
      "unsafe_ignored",
    ]);
  });

  it("supports remove-all and keep-all policy variants", () => {
    const removeAll = buildAutomaticCutPlan(episodes, {
      openings: "remove_all",
      endings: "remove_all",
      removeRecaps: false,
      removePreviews: false,
    });
    expect(
      removeAll.automaticRemovals.every((item) => item.type !== "recap"),
    ).toBe(true);
    const keepAll = buildAutomaticCutPlan(episodes, {
      openings: "keep_all",
      endings: "keep_all",
      removeRecaps: false,
      removePreviews: false,
    });
    expect(keepAll.automaticRemovals).toEqual([]);
  });

  it("normalizes duplicate and overlapping manual plus automatic ranges", () => {
    expect(
      mergeRemovalRanges([
        { episodeId: "ep2", start: 0, end: 6, type: "opening" },
        { episodeId: "ep2", start: 5, end: 8, type: "recap" },
        { episodeId: "ep2", start: 24, end: 30, type: "ending" },
      ]),
    ).toEqual([
      { episodeId: "ep2", start: 0, end: 8, type: "opening" },
      { episodeId: "ep2", start: 24, end: 30, type: "ending" },
    ]);
  });
});
