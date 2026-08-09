import { AniSkipProvider } from "@animetvcut/skip-providers";
import { describe, expect, it } from "vitest";

const animeId = Number(process.env.ANISKIP_TEST_MAL_ID);
const episode = Number(process.env.ANISKIP_TEST_EPISODE);
const duration = Number(process.env.ANISKIP_TEST_DURATION);
const configured =
  Number.isSafeInteger(animeId) &&
  animeId > 0 &&
  Number.isSafeInteger(episode) &&
  episode > 0 &&
  Number.isFinite(duration) &&
  duration > 0;

describe.skipIf(!configured)("optional live AniSkip smoke test", () => {
  it("fetches and normalizes a configured episode without requiring a result", async () => {
    const provider = new AniSkipProvider({ cacheTtlMs: 0 });
    const result = await provider.getSegments({
      identity: { mal: { animeId, episode } },
      durationSeconds: duration,
    });
    expect(result.provider).toBe("aniskip");
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
