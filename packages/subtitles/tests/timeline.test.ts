import { describe, expect, it } from "vitest";
import { mapSubtitleEvents, type SubtitleEvent } from "../src/index.js";
import type { TimelinePiece } from "@animetvcut/core";

const pieces: TimelinePiece[] = [
  {
    id: "p1",
    sourceEpisodeId: "e1",
    sourceStart: 0,
    sourceEnd: 6,
    outputStart: 0,
    outputEnd: 6,
    kind: "content",
  },
  {
    id: "p2",
    sourceEpisodeId: "e1",
    sourceStart: 12,
    sourceEnd: 18,
    outputStart: 6,
    outputEnd: 12,
    kind: "content",
  },
  {
    id: "p3",
    sourceEpisodeId: "e2",
    sourceStart: 6,
    sourceEnd: 18,
    outputStart: 12,
    outputEnd: 24,
    kind: "content",
  },
];
function cue(
  start: number,
  end: number,
  episode = "e1",
  order = 0,
): SubtitleEvent {
  return {
    start,
    end,
    text: "text",
    sourceEpisodeId: episode,
    sourceEpisodeOrder: episode === "e1" ? 0 : 1,
    sourceEventOrder: order,
  };
}
describe("subtitle TimelinePiece mapping", () => {
  it.each([
    [cue(1, 2), [{ start: 1, end: 2 }]],
    [cue(7, 11), []],
    [cue(5, 8), [{ start: 5, end: 6 }]],
    [cue(10, 13), [{ start: 6, end: 7 }]],
    [
      cue(5, 13),
      [
        { start: 5, end: 6 },
        { start: 6, end: 7 },
      ],
    ],
    [cue(6, 12), []],
    [
      cue(4, 14),
      [
        { start: 4, end: 6 },
        { start: 6, end: 8 },
      ],
    ],
    [cue(18, 18), []],
  ])("clips, drops, and splits %j", (input, expected) => {
    expect(
      mapSubtitleEvents([input], pieces).map(({ start, end }) => ({
        start,
        end,
      })),
    ).toEqual(expected);
  });
  it("orders overlaps by mapped coordinates and source order", () => {
    expect(
      mapSubtitleEvents([cue(8, 10, "e2", 1), cue(7, 11, "e2", 0)], pieces).map(
        (item) => item.sourceEventOrder,
      ),
    ).toEqual([0, 1]);
  });
  it("uses actual retained pieces when a requested cut removed no safe segments", () => {
    const full = [{ ...pieces[0]!, sourceEnd: 18, outputEnd: 18 }];
    expect(mapSubtitleEvents([cue(8, 10)], full)).toHaveLength(1);
  });
  it("retains cue portions outside an applied 6-12 cut even if request was 5-13", () => {
    expect(
      mapSubtitleEvents([cue(5, 13)], pieces).map(({ start, end }) => [
        start,
        end,
      ]),
    ).toEqual([
      [5, 6],
      [6, 7],
    ]);
  });
});
