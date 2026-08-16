
import { describe, expect, it } from "vitest";

import { alignRemovedRanges, parseHlsVodPlaylist } from "../src/index.js";

const playlist = parseHlsVodPlaylist(
  `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6,
seg0.ts
#EXTINF:6,
seg1.ts
#EXTINF:6,
seg2.ts
#EXT-X-ENDLIST
`,
  "fixture://episode1/playlist.m3u8",
);

const removal = (start: number, end: number) => ({
  episodeId: "ep1",
  start,
  end,
  type: "opening" as const,
});

describe("cut alignment policies", () => {
  it("expands preserve_content removals to cover full segments", () => {
    expect(alignRemovedRanges(playlist, [removal(5, 13)])).toEqual([
      {
        episodeId: "ep1",
        type: "opening",
        alignmentPolicy: "preserve_content",
        status: "applied",
        requestedStart: 5,
        requestedEnd: 13,
        appliedStart: 0,
        appliedEnd: 18,
        errorStart: -5,
        errorEnd: 5,
      },
    ]);
  });

  it("expands preserve_content removals to fully cover requested range", () => {
    const cuts = alignRemovedRanges(playlist, [removal(0.25, 17.75)]);
    const cut = cuts[0];
    expect(cut?.status).toBe("applied");
    if (cut?.status !== "applied") {
      throw new Error("Expected an applied cut");
    }
    // Applied range must cover the requested range
    expect(cut.appliedStart).toBeLessThanOrEqual(cut.requestedStart);
    expect(cut.appliedEnd).toBeGreaterThanOrEqual(cut.requestedEnd);
  });

  it("expands narrow removals to cover full segment boundaries", () => {
    expect(alignRemovedRanges(playlist, [removal(7, 11)])[0]).toMatchObject({
      status: "applied",
      appliedStart: 6,
      appliedEnd: 12,
      errorStart: -1,
      errorEnd: 1,
    });
  });

  it("does not throw in strict mode when removal can be expanded", () => {
    // With expansion behavior, removal(7, 11) becomes 6->12, which is valid
    expect(() =>
      alignRemovedRanges(playlist, [removal(7, 11)], { strict: true }),
    ).not.toThrow();
  });

  it("applies aggressive policy the same way for removals", () => {
    expect(
      alignRemovedRanges(playlist, [removal(7, 11)], {
        policy: "aggressive",
      })[0],
    ).toMatchObject({
      alignmentPolicy: "aggressive",
      status: "applied",
      appliedStart: 6,
      appliedEnd: 12,
      errorStart: -1,
      errorEnd: 1,
    });
  });
});
