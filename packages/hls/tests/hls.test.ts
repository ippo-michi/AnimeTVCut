import { buildTimeline, type SourceRange } from "@animetvcut/core";
import { describe, expect, it } from "vitest";

import {
  alignRemovedRanges,
  composeHlsVod,
  parseHlsVodPlaylist,
} from "../src/index.js";

const playlistText = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
seg2.ts
#EXT-X-ENDLIST
`;

describe("HLS Phase 1 components", () => {
  it("parses a VOD playlist and calculates segment coordinates", () => {
    const playlist = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
    expect(playlist.duration).toBe(18);
    expect(playlist.segments.map(({ start, end }) => ({ start, end }))).toEqual(
      [
        { start: 0, end: 6 },
        { start: 6, end: 12 },
        { start: 12, end: 18 },
      ],
    );
  });

  it("preserve_content only removes fully-contained segments", () => {
    const playlist = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
    // Removal [7, 11) is NOT fully contained in any segment (6 < 7 and 12 > 11).
    // No segments are removed.
    expect(
      alignRemovedRanges(playlist, [
        { episodeId: "ep1", start: 7, end: 11, type: "opening" },
      ]),
    ).toEqual([
      {
        episodeId: "ep1",
        type: "opening",
        alignmentPolicy: "preserve_content",
        status: "no_safe_segments",
        reason: "no_complete_segments",
        requestedStart: 7,
        requestedEnd: 11,
        appliedStart: null,
        appliedEnd: null,
        errorStart: null,
        errorEnd: null,
      },
    ]);
  });

  it("preserve_content removes segments that fully contain the removal", () => {
    const playlist = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
    // Removal [6, 12) exactly matches segment [6, 12).
    expect(
      alignRemovedRanges(playlist, [
        { episodeId: "ep1", start: 6, end: 12, type: "opening" },
      ]),
    ).toEqual([
      {
        episodeId: "ep1",
        type: "opening",
        alignmentPolicy: "preserve_content",
        status: "applied",
        requestedStart: 6,
        requestedEnd: 12,
        appliedStart: 6,
        appliedEnd: 12,
        errorStart: 0,
        errorEnd: 0,
      },
    ]);
  });

  it("aggressive expands removal to cover all overlapping segments", () => {
    const playlist = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
    // Removal [7, 11) overlaps [6, 12). Aggressive expands to [6, 12).
    expect(
      alignRemovedRanges(
        playlist,
        [{ episodeId: "ep1", start: 7, end: 11, type: "opening" }],
        { policy: "aggressive" },
      ),
    ).toEqual([
      {
        episodeId: "ep1",
        type: "opening",
        alignmentPolicy: "aggressive",
        status: "applied",
        requestedStart: 7,
        requestedEnd: 11,
        appliedStart: 6,
        appliedEnd: 12,
        errorStart: -1,
        errorEnd: 1,
      },
    ]);
  });

  it("creates a VOD manifest with opaque resources and discontinuities", () => {
    const ep1 = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
    const ep2 = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode2/playlist.m3u8",
    );
    const ranges: SourceRange[] = [
      {
        sourceEpisodeId: "ep1",
        sourceStart: 0,
        sourceEnd: 12,
        kind: "content",
      },
      {
        sourceEpisodeId: "ep2",
        sourceStart: 6,
        sourceEnd: 18,
        kind: "content",
      },
    ];
    const result = composeHlsVod(
      "opaque-cut",
      [
        { episodeId: "ep1", playlist: ep1 },
        { episodeId: "ep2", playlist: ep2 },
      ],
      buildTimeline(ranges),
    );

    expect(result.text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(result.text).toContain("#EXT-X-ENDLIST");
    expect(result.text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(result.text).not.toContain("fixture://");
    expect(result.text).not.toContain("seg0.ts");
    expect(result.resources).toHaveLength(4);
  });

  it("composes thousands of retained segments without quadratic manifest assembly", () => {
    const count = 5_000;
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:1",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      ...Array.from({ length: count }, (_, index) => [
        "#EXTINF:1,",
        `s${index}.ts`,
      ]).flat(),
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");
    const source = parseHlsVodPlaylist(text, "fixture://large/playlist.m3u8");
    const started = performance.now();
    const result = composeHlsVod(
      "large",
      [{ episodeId: "large", playlist: source }],
      buildTimeline([
        {
          sourceEpisodeId: "large",
          sourceStart: 0,
          sourceEnd: count,
          kind: "content",
        },
      ]),
    );
    expect(result.segmentCount).toBe(count);
    expect(result.text).toContain("r005000.ts");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
