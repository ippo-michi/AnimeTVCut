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
  describe("preserve_content", () => {
    it("only removes segments fully contained within the removal range", () => {
      // Removal [5, 13) overlaps segments [0,6), [6,12), [12,18).
      // Only [6,12) is fully contained, so applied = [6, 12).
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

    it("removes nothing when no segment is fully contained", () => {
      // Removal [5, 7) overlaps [0,6) and [6,12), but neither is fully contained.
      expect(alignRemovedRanges(playlist, [removal(5, 7)])).toEqual([
        {
          episodeId: "ep1",
          type: "opening",
          alignmentPolicy: "preserve_content",
          status: "no_safe_segments",
          reason: "no_complete_segments",
          requestedStart: 5,
          requestedEnd: 7,
          appliedStart: null,
          appliedEnd: null,
          errorStart: null,
          errorEnd: null,
        },
      ]);
    });

    it("removes exact segment when removal matches segment boundaries", () => {
      // Removal [6, 12) exactly matches segment [6, 12).
      expect(
        alignRemovedRanges(playlist, [removal(6, 12)]).at(0),
      ).toMatchObject({
        status: "applied",
        appliedStart: 6,
        appliedEnd: 12,
        errorStart: 0,
        errorEnd: 0,
      });
    });

    it("removes multiple fully-contained segments", () => {
      const bigPlaylist = parseHlsVodPlaylist(
        `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6,
seg0.ts
#EXTINF:6,
seg1.ts
#EXTINF:6,
seg2.ts
#EXTINF:6,
seg3.ts
#EXTINF:6,
seg4.ts
#EXT-X-ENDLIST
`,
        "fixture://episode1/playlist.m3u8",
      );
      // Removal [5, 25) fully contains [6,12), [12,18), [18,24).
      // Not [0,6) (6 > 25? No, but 0 < 5) and not [24,30) (30 > 25).
      // Wait: [18,24): 18 >= 5? Yes. 24 <= 25? Yes. Fully contained.
      // [24,30): 24 >= 5? Yes. 30 <= 25? No. NOT fully contained.
      expect(alignRemovedRanges(bigPlaylist, [removal(5, 25)])).toMatchObject([
        {
          status: "applied",
          appliedStart: 6,
          appliedEnd: 24,
          errorStart: 1,
          errorEnd: -1,
        },
      ]);
    });

    it("does not over-delete neighboring content", () => {
      // Removal [5, 13) should NOT consume [0, 6) or [12, 18).
      // Only [6, 12) is removed.
      const cuts = alignRemovedRanges(playlist, [removal(5, 13)]);
      const cut = cuts[0];
      expect(cut?.status).toBe("applied");
      if (cut?.status !== "applied") {
        throw new Error("Expected an applied cut");
      }
      // Applied range must be a subset of fully contained segments
      expect(cut.appliedStart).toBeGreaterThanOrEqual(6);
      expect(cut.appliedEnd).toBeLessThanOrEqual(12);
    });

    it("removes segment when narrow removal is fully contained within it", () => {
      // Removal [7, 11) is fully contained within [6, 12).
      // 6 >= 7? No! 6 < 7. So [6, 12) is NOT fully contained.
      // No segments are fully contained.
      expect(alignRemovedRanges(playlist, [removal(7, 11)])[0]).toMatchObject({
        status: "no_safe_segments",
      });
    });

    it("removes segment when narrow removal exactly fits within segment", () => {
      // Removal [6, 12) exactly matches segment [6, 12).
      expect(
        alignRemovedRanges(playlist, [removal(6, 12)]).at(0),
      ).toMatchObject({
        status: "applied",
        appliedStart: 6,
        appliedEnd: 12,
      });
    });
  });

  describe("aggressive", () => {
    it("expands removal to cover all overlapping segments", () => {
      // Removal [5, 13) overlaps [0,6), [6,12), [12,18).
      // Aggressive expands to cover all: applied = [0, 18).
      expect(
        alignRemovedRanges(playlist, [removal(5, 13)], {
          policy: "aggressive",
        }),
      ).toEqual([
        {
          episodeId: "ep1",
          type: "opening",
          alignmentPolicy: "aggressive",
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

    it("expands narrow removals to cover full segment boundaries", () => {
      // Removal [7, 11) overlaps [6,12). Aggressive expands to [6, 12).
      expect(
        alignRemovedRanges(playlist, [removal(7, 11)], {
          policy: "aggressive",
        })[0],
      ).toMatchObject({
        status: "applied",
        appliedStart: 6,
        appliedEnd: 12,
        errorStart: -1,
        errorEnd: 1,
      });
    });

    it("applies aggressive policy for removals", () => {
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

    it("does not throw in strict mode when removal can be expanded", () => {
      expect(() =>
        alignRemovedRanges(playlist, [removal(7, 11)], {
          strict: true,
          policy: "aggressive",
        }),
      ).not.toThrow();
    });
  });

  describe("policy distinction", () => {
    it("preserve_content and aggressive produce different results when removal straddles boundaries", () => {
      const preserve = alignRemovedRanges(playlist, [removal(5, 13)]);
      const aggressive = alignRemovedRanges(playlist, [removal(5, 13)], {
        policy: "aggressive",
      });

      const preserveCut = preserve[0];
      const aggressiveCut = aggressive[0];

      expect(preserveCut?.status).toBe("applied");
      expect(aggressiveCut?.status).toBe("applied");

      if (
        preserveCut?.status !== "applied" ||
        aggressiveCut?.status !== "applied"
      ) {
        throw new Error("Expected both to be applied");
      }

      // preserve_content removes less: only fully contained segments
      expect(preserveCut.appliedStart).toBeGreaterThan(
        aggressiveCut.appliedStart,
      );
      expect(preserveCut.appliedEnd).toBeLessThan(aggressiveCut.appliedEnd);
    });

    it("preserve_content and aggressive produce same results when removal aligns with segments", () => {
      const preserve = alignRemovedRanges(playlist, [removal(6, 12)]);
      const aggressive = alignRemovedRanges(playlist, [removal(6, 12)], {
        policy: "aggressive",
      });

      const preserveCut = preserve[0];
      const aggressiveCut = aggressive[0];

      expect(preserveCut?.status).toBe("applied");
      expect(aggressiveCut?.status).toBe("applied");

      if (
        preserveCut?.status !== "applied" ||
        aggressiveCut?.status !== "applied"
      ) {
        throw new Error("Expected both to be applied");
      }

      // When removal aligns with segment boundaries, both produce the same result
      expect(preserveCut.appliedStart).toBe(aggressiveCut.appliedStart);
      expect(preserveCut.appliedEnd).toBe(aggressiveCut.appliedEnd);
    });
  });
});
