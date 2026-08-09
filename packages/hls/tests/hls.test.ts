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

  it("defaults to preserving content when no complete segment is removable", () => {
    const playlist = parseHlsVodPlaylist(
      playlistText,
      "fixture://episode1/playlist.m3u8",
    );
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
});
