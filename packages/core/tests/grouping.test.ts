import { describe, expect, it } from "vitest";

import {
  DEFAULT_TV_CUT_GROUPING_CONFIG,
  groupTvCutEpisodes,
  parseRuntimeSeconds,
} from "../src/index.js";

const oldNow = Date.parse("2026-01-01T00:00:00Z");
const episodes = (count: number, released = "2025-01-01T00:00:00Z") =>
  Array.from({ length: count }, (_, index) => ({
    sourceId: `opaque:${index + 1}`,
    season: 1,
    episode: index + 1,
    released,
    runtimeSeconds: 1440,
  }));

describe("runtime parsing", () => {
  it.each([
    ["24 min", 1440],
    ["1h 30m", 5400],
    ["1 hour, 5 minutes", 3900],
    [24, 1440],
  ])("parses %j", (value, expected) => {
    expect(parseRuntimeSeconds(value)).toBe(expected);
  });

  it.each(["24ish", "1:30", "unknown", -1, Number.POSITIVE_INFINITY])(
    "rejects ambiguous runtime %j",
    (value) => expect(parseRuntimeSeconds(value)).toBeUndefined(),
  );
});

describe("stable TV cut grouping", () => {
  it("groups six 24-minute episodes as stable groups of three", () => {
    const result = groupTvCutEpisodes(episodes(6), { now: oldNow });
    expect(
      result.groups.map((group) => [
        group.firstEpisode,
        group.lastEpisode,
        group.estimatedDurationSeconds,
      ]),
    ).toEqual([
      [1, 3, 3960],
      [4, 6, 3960],
    ]);
    expect(result.groups.every((group) => group.finalized)).toBe(true);
  });

  it("keeps a fresh below-minimum tail pending without changing prior groups", () => {
    const first = groupTvCutEpisodes(episodes(4, "2025-12-31T00:00:00Z"), {
      now: oldNow,
    });
    const second = groupTvCutEpisodes(episodes(5, "2025-12-31T00:00:00Z"), {
      now: oldNow,
    });
    expect(first.groups[0]).toMatchObject({
      firstEpisode: 1,
      lastEpisode: 3,
      finalized: true,
    });
    expect(first.groups[1]).toMatchObject({
      firstEpisode: 4,
      lastEpisode: 4,
      finalized: false,
    });
    expect(second.groups[0]).toMatchObject({
      firstEpisode: 1,
      lastEpisode: 3,
      finalized: true,
    });
    expect(second.groups[1]).toMatchObject({
      firstEpisode: 4,
      lastEpisode: 5,
      finalized: false,
    });
  });

  it("keeps even a maximum-sized below-minimum trailing group pending", () => {
    const config = {
      ...DEFAULT_TV_CUT_GROUPING_CONFIG,
      minimumSeconds: 10_000,
      maximumEpisodes: 4,
    };
    const result = groupTvCutEpisodes(
      episodes(4, "2025-12-31T00:00:00Z").map((episode) => ({
        ...episode,
        runtimeSeconds: 1000,
      })),
      { now: oldNow, config },
    );
    expect(result.groups[0]).toMatchObject({ finalized: false });
  });

  it("finalizes an aged trailing group", () => {
    const result = groupTvCutEpisodes(episodes(1), { now: oldNow });
    expect(result.groups[0]?.finalized).toBe(true);
  });

  it("splits at season boundaries and episode gaps", () => {
    const result = groupTvCutEpisodes(
      [
        ...episodes(2),
        { ...episodes(1)[0]!, sourceId: "gap", episode: 4 },
        { ...episodes(1)[0]!, sourceId: "special", season: 2 },
      ],
      { now: oldNow },
    );
    expect(
      result.groups.map((group) => [
        group.season,
        group.firstEpisode,
        group.lastEpisode,
      ]),
    ).toEqual([
      [1, 1, 2],
      [1, 4, 4],
      [2, 1, 1],
    ]);
  });

  it("keeps the first duplicate and warns", () => {
    const result = groupTvCutEpisodes(
      [episodes(1)[0]!, { ...episodes(1)[0]!, sourceId: "later" }],
      { now: oldNow },
    );
    expect(result.groups[0]?.episodes[0]?.sourceId).toBe("opaque:1");
    expect(result.warnings).toHaveLength(1);
  });

  it("excludes future episodes", () => {
    const result = groupTvCutEpisodes(episodes(3, "2027-01-01T00:00:00Z"), {
      now: oldNow,
    });
    expect(result.groups).toEqual([]);
  });

  it("honors maximum episodes and permits an overlong singleton", () => {
    const config = {
      ...DEFAULT_TV_CUT_GROUPING_CONFIG,
      minimumSeconds: 10_000,
      maximumEpisodes: 2,
    };
    const capped = groupTvCutEpisodes(episodes(3), { now: oldNow, config });
    expect(capped.groups[0]?.episodes).toHaveLength(2);
    const long = groupTvCutEpisodes(
      [{ ...episodes(1)[0]!, runtimeSeconds: 5000 }],
      { now: oldNow },
    );
    expect(long.groups[0]).toMatchObject({
      finalized: true,
      estimatedDurationSeconds: 5000,
    });
  });
});
