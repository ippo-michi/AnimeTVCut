import { DomainValidationError } from "@animetvcut/core";
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
  it("removes only complete segments contained by preserve_content ranges", () => {
    expect(alignRemovedRanges(playlist, [removal(5, 13)])).toEqual([
      {
        episodeId: "ep1",
        type: "opening",
        alignmentPolicy: "preserve_content",
        status: "applied",
        requestedStart: 5,
        requestedEnd: 13,
        appliedStart: 6,
        appliedEnd: 12,
        errorStart: 1,
        errorEnd: -1,
      },
    ]);
  });

  it("never extends a preserve_content removal outside its request", () => {
    const cuts = alignRemovedRanges(playlist, [removal(0.25, 17.75)]);
    const cut = cuts[0];
    expect(cut?.status).toBe("applied");
    if (cut?.status !== "applied") {
      throw new Error("Expected an applied cut");
    }
    expect(cut.appliedStart).toBeGreaterThanOrEqual(cut.requestedStart);
    expect(cut.appliedEnd).toBeLessThanOrEqual(cut.requestedEnd);
  });

  it("reports no safely removable segment without deleting media", () => {
    expect(alignRemovedRanges(playlist, [removal(7, 11)])[0]).toMatchObject({
      status: "no_safe_segments",
      reason: "no_complete_segments",
      appliedStart: null,
      appliedEnd: null,
    });
  });

  it("throws for a no-segment result only when strict alignment is requested", () => {
    expect(() =>
      alignRemovedRanges(playlist, [removal(7, 11)], { strict: true }),
    ).toThrow(DomainValidationError);
  });

  it("retains explicit aggressive outward alignment", () => {
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
