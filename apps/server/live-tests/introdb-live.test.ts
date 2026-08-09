import { TheIntroDbProvider } from "@animetvcut/skip-providers";
import { describe, expect, it } from "vitest";

const imdbId = process.env.INTRODB_TEST_IMDB_ID;
const season = Number(process.env.INTRODB_TEST_SEASON);
const episode = Number(process.env.INTRODB_TEST_EPISODE);
const duration = Number(process.env.INTRODB_TEST_DURATION);
const configured =
  imdbId !== undefined &&
  Number.isSafeInteger(season) &&
  season > 0 &&
  Number.isSafeInteger(episode) &&
  episode > 0 &&
  Number.isFinite(duration) &&
  duration > 0;

describe.skipIf(!configured)("optional live TheIntroDB smoke test", () => {
  it("fetches and normalizes a configured episode without requiring a result", async () => {
    const provider = new TheIntroDbProvider({ cacheTtlMs: 0 });
    const result = await provider.getSegments({
      identity: { imdb: { id: imdbId!, season, episode } },
      durationSeconds: duration,
    });
    expect(result.provider).toBe("theintrodb");
    expect(result.status).toMatch(/found|not_found/);
    expect(
      result.segments.every(
        (segment) =>
          Number.isFinite(segment.start) &&
          (segment.end === null || Number.isFinite(segment.end)),
      ),
    ).toBe(true);
  });
});
