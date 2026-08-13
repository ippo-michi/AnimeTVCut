import { buildTimeline, type SourceRange } from "@animetvcut/core";
import { describe, expect, it } from "vitest";

import {
  HlsParseError,
  composeHlsVod,
  parseHlsVodPlaylist,
  type HlsVodPlaylist,
} from "../src/index.js";

function composeSingle(playlist: HlsVodPlaylist) {
  const ranges: SourceRange[] = [
    {
      sourceEpisodeId: "ep1",
      sourceStart: 0,
      sourceEnd: playlist.duration,
      kind: "content",
    },
  ];
  return composeHlsVod(
    "cut",
    [{ episodeId: "ep1", playlist }],
    buildTimeline(ranges),
  );
}

function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("fMP4 parsing and EXT-X-MAP composition", () => {
  it("classifies fMP4 maps and segments without renaming them to TS", () => {
    const playlist = parseHlsVodPlaylist(
      `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg0.m4s
#EXT-X-ENDLIST
`,
      "fixture://fmp4-episode1/playlist.m3u8",
    );
    expect(playlist.segments[0]).toMatchObject({
      mediaFormat: "fmp4",
      contentType: "video/mp4",
      safeExtension: ".m4s",
      map: {
        mediaFormat: "fmp4",
        contentType: "video/mp4",
        safeExtension: ".mp4",
      },
    });

    const composed = composeSingle(playlist);
    expect(composed.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "map",
          mediaFormat: "fmp4",
          id: "r000001.mp4",
        }),
        expect.objectContaining({
          kind: "segment",
          mediaFormat: "fmp4",
          id: "r000002.m4s",
        }),
      ]),
    );
    expect(
      composed.resources.find((resource) => resource.kind === "segment"),
    ).toMatchObject({ sourceStart: 0, outputStart: 0 });
  });

  it("emits one map when the same map is reused", () => {
    const playlist = parseHlsVodPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg0.m4s
#EXTINF:6,
seg1.m4s
#EXT-X-ENDLIST
`,
      "fixture://fmp4-episode1/playlist.m3u8",
    );
    const composed = composeSingle(playlist);
    expect(count(composed.text, "#EXT-X-MAP:")).toBe(1);
    expect(
      composed.resources.filter((resource) => resource.kind === "map"),
    ).toHaveLength(1);
  });

  it("emits a replacement map when the map changes", () => {
    const playlist = parseHlsVodPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init-a.mp4"
#EXTINF:6,
seg0.m4s
#EXT-X-MAP:URI="init-b.mp4"
#EXTINF:6,
seg1.m4s
#EXT-X-ENDLIST
`,
      "fixture://fmp4-episode1/playlist.m3u8",
    );
    const composed = composeSingle(playlist);
    expect(count(composed.text, "#EXT-X-MAP:")).toBe(2);
    expect(
      composed.resources.filter((resource) => resource.kind === "map"),
    ).toHaveLength(2);
  });

  it("re-emits the active map after a discontinuity", () => {
    const playlist = parseHlsVodPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg0.m4s
#EXT-X-DISCONTINUITY
#EXTINF:6,
seg1.m4s
#EXT-X-ENDLIST
`,
      "fixture://fmp4-episode1/playlist.m3u8",
    );
    const composed = composeSingle(playlist);
    expect(count(composed.text, "#EXT-X-MAP:")).toBe(2);
    expect(count(composed.text, "#EXT-X-DISCONTINUITY")).toBe(1);
    expect(
      composed.resources.filter((resource) => resource.kind === "map"),
    ).toHaveLength(1);
  });

  it("uses a separate opaque map at each episode boundary", () => {
    const source = (episode: string) =>
      parseHlsVodPlaylist(
        `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg0.m4s
#EXT-X-ENDLIST
`,
        `fixture://fmp4-${episode}/playlist.m3u8`,
      );
    const ep1 = source("episode1");
    const ep2 = source("episode2");
    const composed = composeHlsVod(
      "cut",
      [
        { episodeId: "ep1", playlist: ep1 },
        { episodeId: "ep2", playlist: ep2 },
      ],
      buildTimeline([
        {
          sourceEpisodeId: "ep1",
          sourceStart: 0,
          sourceEnd: 6,
          kind: "content",
        },
        {
          sourceEpisodeId: "ep2",
          sourceStart: 0,
          sourceEnd: 6,
          kind: "content",
        },
      ]),
    );
    expect(count(composed.text, "#EXT-X-MAP:")).toBe(2);
    expect(count(composed.text, "#EXT-X-DISCONTINUITY")).toBe(1);
    expect(
      composed.resources.filter((resource) => resource.kind === "map"),
    ).toHaveLength(2);
    expect(composed.text).not.toContain("init.mp4");
    expect(composed.text).not.toContain("fixture://");
    expect(
      composed.resources.filter((resource) => resource.kind === "segment"),
    ).toEqual([
      expect.objectContaining({ sourceStart: 0, outputStart: 0 }),
      expect.objectContaining({ sourceStart: 0, outputStart: 6 }),
    ]);
  });

  it("preserves map byte ranges and includes them in map resource identity", () => {
    const playlist = parseHlsVodPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="shared.mp4",BYTERANGE="100@0"
#EXTINF:6,
seg0.m4s
#EXT-X-MAP:URI="shared.mp4",BYTERANGE="120@100"
#EXTINF:6,
seg1.m4s
#EXT-X-ENDLIST
`,
      "fixture://fmp4-episode1/playlist.m3u8",
    );
    const composed = composeSingle(playlist);
    expect(composed.text).toContain('BYTERANGE="100@0"');
    expect(composed.text).toContain('BYTERANGE="120@100"');
    expect(
      composed.resources.filter((resource) => resource.kind === "map"),
    ).toEqual([
      expect.objectContaining({ byteRange: "100@0" }),
      expect.objectContaining({ byteRange: "120@100" }),
    ]);
  });

  it("rejects malformed map, numeric, and dangling segment state", () => {
    expect(() =>
      parseHlsVodPlaylist(
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="http://[bad"\n#EXTINF:6,\nseg.m4s\n#EXT-X-ENDLIST\n',
        "fixture://fmp4-episode1/playlist.m3u8",
      ),
    ).toThrow(HlsParseError);
    expect(() =>
      parseHlsVodPlaylist(
        "#EXTM3U\n#EXT-X-TARGETDURATION:Infinity\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n",
        "fixture://episode1/playlist.m3u8",
      ),
    ).toThrow(HlsParseError);
    expect(() =>
      parseHlsVodPlaylist(
        "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n#EXT-X-ENDLIST\n",
        "fixture://episode1/playlist.m3u8",
      ),
    ).toThrow(HlsParseError);
  });
});
