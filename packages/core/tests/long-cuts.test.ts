import { describe, expect, it } from "vitest";

import {
  DEFAULT_LONG_CUT_PLANNING_CONFIG,
  planLongCuts,
  type LongCutEpisode,
} from "../src/index.js";

const now = Date.parse("2026-01-01T00:00:00Z");
function episodes(
  seasons: readonly [number, number][],
  released = "2025-01-01T00:00:00Z",
): LongCutEpisode[] {
  return seasons.flatMap(([season, count]) =>
    Array.from({ length: count }, (_, index) => ({
      sourceId: `s${season}e${index + 1}`,
      season,
      episode: index + 1,
      released,
      runtimeSeconds: 1_440,
    })),
  );
}

describe("long-cut planning", () => {
  it("finalizes complete consecutive seasons and a multi-season series", () => {
    const plan = planLongCuts(
      episodes([
        [1, 6],
        [2, 6],
      ]),
      { now },
    );
    expect(plan.seasonCuts.map((item) => item.eligible)).toEqual([true, true]);
    expect(plan.seriesCut).toMatchObject({
      eligible: true,
      seasons: [1, 2],
      estimatedDurationSeconds: 12 * 1_440,
    });
  });

  it("rejects gaps for the affected season and complete series", () => {
    const input = episodes([[1, 3]]).filter((item) => item.episode !== 2);
    const plan = planLongCuts(input, { now });
    expect(plan.seasonCuts[0]).toMatchObject({
      eligible: false,
      reason: "episode_gap",
    });
    expect(plan.seriesCut.reason).toBe("episode_gap");
  });

  it("uses first occurrence for duplicates and reports a warning", () => {
    const input = episodes([[1, 2]]);
    const plan = planLongCuts(
      [...input, { ...input[0]!, sourceId: "duplicate" }],
      {
        now,
      },
    );
    expect(plan.seasonCuts[0]?.eligible).toBe(true);
    expect(plan.seasonCuts[0]?.episodes.map((item) => item.sourceId)).toEqual([
      "s1e1",
      "s1e2",
    ]);
    expect(plan.seasonCuts[0]?.warnings).toEqual(["duplicate_episode:1:1"]);
  });

  it("keeps recently released seasons unavailable until grace elapses", () => {
    const input = episodes([[1, 3]], "2025-12-31T00:00:00Z");
    expect(planLongCuts(input, { now }).seasonCuts[0]?.reason).toBe(
      "still_airing",
    );
    expect(
      planLongCuts(input, {
        now: now + 15 * 24 * 60 * 60 * 1000,
      }).seasonCuts[0]?.eligible,
    ).toBe(true);
  });

  it("does not assume missing release dates are finalized by default", () => {
    const input = episodes([[1, 2]]);
    for (const item of input) delete item.released;
    expect(planLongCuts(input, { now }).seasonCuts[0]?.reason).toBe(
      "unknown_release_dates",
    );
    expect(
      planLongCuts(input, {
        now,
        config: {
          ...DEFAULT_LONG_CUT_PLANNING_CONFIG,
          allowUnknownReleaseDates: true,
        },
      }).seasonCuts[0]?.eligible,
    ).toBe(true);
  });

  it("keeps season zero independent and excludes it from Complete Cut", () => {
    const plan = planLongCuts(
      episodes([
        [0, 2],
        [1, 2],
      ]),
      { now },
    );
    expect(plan.seasonCuts.map((item) => item.season)).toEqual([0, 1]);
    expect(plan.seasonCuts.every((item) => item.eligible)).toBe(true);
    expect(plan.seriesCut.episodes.map((item) => item.season)).toEqual([1, 1]);
  });

  it("includes opted-in season zero only with unambiguous chronology", () => {
    const input = [
      ...episodes([[0, 2]], "2024-01-01T00:00:00Z"),
      ...episodes([[1, 2]], "2025-01-01T00:00:00Z"),
    ];
    const config = {
      ...DEFAULT_LONG_CUT_PLANNING_CONFIG,
      includeSeasonZeroInSeries: true,
    };
    expect(
      planLongCuts(input, { now, config }).seriesCut.episodes.map(
        (item) => item.season,
      ),
    ).toEqual([0, 0, 1, 1]);

    const ambiguous = input.map((item) =>
      item.season === 0 ? { ...item, released: "2025-02-01T00:00:00Z" } : item,
    );
    const plan = planLongCuts(ambiguous, { now, config });
    expect(plan.seriesCut.episodes.map((item) => item.season)).toEqual([1, 1]);
    expect(plan.seriesCut.warnings).toContain(
      "season_zero_excluded:ambiguous_order",
    );
  });

  it("applies season and series episode/duration limits independently", () => {
    const input = episodes([
      [1, 4],
      [2, 4],
    ]);
    const plan = planLongCuts(input, {
      now,
      config: {
        ...DEFAULT_LONG_CUT_PLANNING_CONFIG,
        seasonMaxEpisodes: 6,
        seriesMaxEpisodes: 7,
      },
    });
    expect(plan.seasonCuts.every((item) => item.eligible)).toBe(true);
    expect(plan.seriesCut.reason).toBe("episode_limit");

    const durationPlan = planLongCuts(episodes([[1, 2]]), {
      now,
      config: {
        ...DEFAULT_LONG_CUT_PLANNING_CONFIG,
        seasonMaxEstimatedSeconds: 2_000,
      },
    });
    expect(durationPlan.seasonCuts[0]?.reason).toBe("duration_limit");
  });
});
