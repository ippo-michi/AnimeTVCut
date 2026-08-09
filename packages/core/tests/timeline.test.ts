import { describe, expect, it } from "vitest";

import { buildTimeline, TimelineMapper, type SourceRange } from "../src/index.js";

const ranges: SourceRange[] = [
  { sourceEpisodeId: "ep1", sourceStart: 0, sourceEnd: 24, kind: "content" },
  { sourceEpisodeId: "ep2", sourceStart: 6, sourceEnd: 24, kind: "content" },
  { sourceEpisodeId: "ep3", sourceStart: 6, sourceEnd: 30, kind: "content" },
];

describe("timeline", () => {
  const pieces = buildTimeline(ranges);
  const mapper = new TimelineMapper(pieces);

  it("calculates contiguous output coordinates", () => {
    expect(pieces.map(({ outputStart, outputEnd }) => ({ outputStart, outputEnd }))).toEqual([
      { outputStart: 0, outputEnd: 24 },
      { outputStart: 24, outputEnd: 42 },
      { outputStart: 42, outputEnd: 66 },
    ]);
  });

  it("maps source coordinates to output coordinates", () => {
    expect(mapper.sourceToOutput("ep1", 5)).toBe(5);
    expect(mapper.sourceToOutput("ep2", 6)).toBe(24);
    expect(mapper.sourceToOutput("ep2", 20)).toBe(38);
    expect(mapper.sourceToOutput("ep3", 12)).toBe(48);
    expect(mapper.sourceToOutput("ep2", 2)).toBeNull();
  });

  it("maps output coordinates to source coordinates", () => {
    expect(mapper.outputToSource(0)).toEqual({ episodeId: "ep1", sourceTime: 0 });
    expect(mapper.outputToSource(24)).toEqual({ episodeId: "ep2", sourceTime: 6 });
    expect(mapper.outputToSource(45)).toEqual({ episodeId: "ep3", sourceTime: 9 });
  });

  it("uses half-open internal boundaries and includes the final endpoint", () => {
    expect(mapper.sourceToOutput("ep1", 24)).toBeNull();
    expect(mapper.outputToSource(42)).toEqual({ episodeId: "ep3", sourceTime: 6 });
    expect(mapper.outputToSource(66)).toEqual({ episodeId: "ep3", sourceTime: 30 });
    expect(mapper.sourceToOutput("ep3", 30)).toBe(66);
    expect(mapper.outputToSource(-0.001)).toBeNull();
    expect(mapper.outputToSource(66.001)).toBeNull();
  });
});
