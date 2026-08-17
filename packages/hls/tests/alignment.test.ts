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
    it("produces exact applied range matching the request", () => {
      // Removal [5, 13) → applied [5, 13) (exact).
      // Partial segment trimming is handled by the composer.
      expect(alignRemovedRanges(playlist, [removal(5, 13)])).toEqual([
        {
          episodeId: "ep1",
          type: "opening",
          alignmentPolicy: "preserve_content",
          status: "applied",
          requestedStart: 5,
          requestedEnd: 13,
          appliedStart: 5,
          appliedEnd: 13,
          errorStart: 0,
          errorEnd: 0,
        },
      ]);
    });

    it("produces exact applied range for boundary-aligned removal", () => {
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

    it("produces exact applied range for narrow removal", () => {
      expect(alignRemovedRanges(playlist, [removal(7, 11)])[0]).toMatchObject({
        status: "applied",
        appliedStart: 7,
        appliedEnd: 11,
        errorStart: 0,
        errorEnd: 0,
      });
    });
  });

  describe("aggressive", () => {
    it("produces exact applied range (same as preserve_content)", () => {
      // Both policies now produce exact ranges.
      // The composer handles partial segment trimming.
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
          appliedStart: 5,
          appliedEnd: 13,
          errorStart: 0,
          errorEnd: 0,
        },
      ]);
    });
  });

  describe("policy equivalence", () => {
    it("preserve_content and aggressive produce identical results", () => {
      const preserve = alignRemovedRanges(playlist, [removal(5, 13)]);
      const aggressive = alignRemovedRanges(playlist, [removal(5, 13)], {
        policy: "aggressive",
      });

      expect(preserve[0]?.status).toBe("applied");
      expect(aggressive[0]?.status).toBe("applied");

      if (
        preserve[0]?.status !== "applied" ||
        aggressive[0]?.status !== "applied"
      ) {
        throw new Error("Expected both to be applied");
      }

      // Both produce exact ranges
      expect(preserve[0]!.appliedStart).toBe(aggressive[0]!.appliedStart);
      expect(preserve[0]!.appliedEnd).toBe(aggressive[0]!.appliedEnd);
    });
  });
});
