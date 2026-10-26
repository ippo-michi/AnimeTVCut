import { buildTimeline } from "@animetvcut/core";
import { describe, expect, it } from "vitest";
import { composeHlsVod, parseHlsVodPlaylist } from "../src/index.js";

function compose(ranges: [number, number][], spans = true) {
  const playlist = parseHlsVodPlaylist(
    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n" +
      [0, 1, 2, 3].map((i) => `#EXTINF:6,\ns${i}.ts\n`).join("") +
      "#EXT-X-ENDLIST\n",
    "https://normalizer.test/playlist.m3u8",
  );
  playlist.exactSegmentSpans = spans;
  // Normalized coordinates may have a different origin from source media.
  for (const segment of playlist.segments) {
    segment.mediaStart = segment.start + 100;
    segment.mediaEnd = segment.end + 100;
  }
  const pieces = buildTimeline(
    ranges.map(([sourceStart, sourceEnd]) => ({
      sourceEpisodeId: "ep1",
      sourceStart,
      sourceEnd,
      kind: "content",
    })),
  );
  const composed = composeHlsVod(
    "cut",
    [{ episodeId: "ep1", playlist }],
    pieces,
  );
  return {
    ...composed,
    parsed: parseHlsVodPlaylist(
      composed.text,
      "https://addon.test/playlist.m3u8",
    ),
  };
}

describe("retained fragments shorter than a frame", () => {
  it("combines the 1ms Grand Blue-style post-ending fragment with the following footage", () => {
    const result = compose([[11.999, 24]]);
    expect(result.segmentCount).toBe(2);
    expect(
      result.resources.map((r) => [r.sourceStart, r.sourceEnd, r.outputStart]),
    ).toEqual([
      [111.999, 118, 0],
      [118, 124, 6.0009999999999994],
    ]);
    expect(result.duration).toBeCloseTo(12.001, 6);
    expect(result.parsed.targetDuration).toBe(7);
    expect(
      Math.min(...result.parsed.segments.map((s) => s.duration)),
    ).toBeGreaterThan(6 - 1e-6);
  });
  it("combines tiny tails into the preceding segment without altering the cut", () => {
    const result = compose([[0, 6.001]]);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({
      sourceStart: 100,
      sourceEnd: 106.001,
      outputStart: 0,
    });
    expect(result.duration).toBe(6.001);
  });
  it("never spans a removed range or joins different timeline pieces", () => {
    const result = compose([
      [0, 6.001],
      [12, 24],
    ]);
    expect(result.resources.map((r) => [r.sourceStart, r.sourceEnd])).toEqual([
      [100, 106.001],
      [112, 118],
      [118, 124],
    ]);
    expect(result.text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(result.duration).toBeCloseTo(18.001, 6);
  });
  it("leaves loaders without span support unchanged", () => {
    const result = compose([[11.999, 24]], false);
    expect(result.segmentCount).toBe(3);
    expect(result.parsed.segments[0]?.duration).toBe(0.001);
  });
});
