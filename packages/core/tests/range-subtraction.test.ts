import { describe, expect, it } from "vitest";

import {
  DomainValidationError,
  subtractRemovedRanges,
  type RemovedRange,
  type SourceRange,
} from "../src/index.js";

const source: SourceRange = {
  sourceEpisodeId: "ep1",
  sourceStart: 0,
  sourceEnd: 30,
  kind: "content",
};

function removed(start: number, end: number): RemovedRange {
  return { episodeId: "ep1", start, end, type: "ending" };
}

describe("subtractRemovedRanges", () => {
  it("subtracts one removed range", () => {
    expect(subtractRemovedRanges(source, [removed(6, 12)])).toEqual([
      { ...source, sourceEnd: 6 },
      { ...source, sourceStart: 12 },
    ]);
  });

  it("subtracts multiple ranges", () => {
    expect(
      subtractRemovedRanges(source, [removed(24, 30), removed(0, 6)]),
    ).toEqual([{ ...source, sourceStart: 6, sourceEnd: 24 }]);
  });

  it("preserves a range after an ending", () => {
    expect(subtractRemovedRanges(source, [removed(18, 24)])).toEqual([
      { ...source, sourceEnd: 18 },
      { ...source, sourceStart: 24 },
    ]);
  });

  it("rejects invalid overlapping ranges", () => {
    expect(() =>
      subtractRemovedRanges(source, [removed(5, 12), removed(10, 14)]),
    ).toThrow(DomainValidationError);
  });
});
