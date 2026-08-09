import { describe, expect, it } from "vitest";

import {
  mapOutputSkipSegments,
  type SafeSourceSkipSegment,
  type TimelinePiece,
} from "../src/index.js";

function piece(
  sourceEpisodeId: string,
  sourceStart: number,
  sourceEnd: number,
  outputStart: number,
): TimelinePiece {
  return {
    id: `${sourceEpisodeId}-${sourceStart}`,
    sourceEpisodeId,
    sourceStart,
    sourceEnd,
    outputStart,
    outputEnd: outputStart + sourceEnd - sourceStart,
    kind: "content",
  };
}

function segment(
  overrides: Partial<SafeSourceSkipSegment> = {},
): SafeSourceSkipSegment {
  return {
    sourceEpisodeId: "ep1",
    type: "opening",
    start: 0,
    end: 6,
    decision: "keep",
    ...overrides,
  };
}

describe("output timeline skip mapping", () => {
  it("maps policy-kept segments through actual TimelinePiece coordinates", () => {
    const result = mapOutputSkipSegments(
      [piece("ep1", 0, 30, 0), piece("ep2", 6, 30, 30)],
      [
        segment(),
        segment({ sourceEpisodeId: "ep2", start: 24, end: 30, type: "ending" }),
      ],
    );
    expect(result.segments).toEqual([
      expect.objectContaining({
        id: "s01",
        type: "intro",
        start: 0,
        end: 6,
        reason: "policy_kept",
      }),
      expect.objectContaining({
        id: "s02",
        type: "outro",
        start: 48,
        end: 54,
        reason: "policy_kept",
      }),
    ]);
  });

  it("omits a fully removed safe segment", () => {
    const result = mapOutputSkipSegments(
      [piece("ep1", 0, 6, 0), piece("ep1", 12, 18, 6)],
      [segment({ start: 6, end: 12, decision: "remove" })],
    );
    expect(result.segments).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ status: "fully_removed" });
  });

  it("marks a requested removal with no removable segment as alignment-retained", () => {
    const result = mapOutputSkipSegments(
      [piece("ep1", 0, 18, 0)],
      [segment({ start: 7, end: 11, decision: "remove" })],
    );
    expect(result.segments[0]).toMatchObject({
      start: 7,
      end: 11,
      reason: "alignment_retained",
    });
  });

  it("maps only safe fragments after a partial aligned removal", () => {
    const result = mapOutputSkipSegments(
      [piece("ep1", 0, 6, 0), piece("ep1", 12, 18, 6)],
      [segment({ start: 5, end: 13, decision: "remove" })],
    );
    expect(result.segments).toEqual([
      expect.objectContaining({
        start: 5,
        end: 7,
        reason: "partially_retained",
      }),
    ]);
  });

  it("omits every ambiguously overlapping output segment", () => {
    const result = mapOutputSkipSegments(
      [piece("ep1", 0, 100, 0)],
      [
        segment({ start: 0, end: 30, type: "recap" }),
        segment({ start: 20, end: 90, type: "opening" }),
      ],
    );
    expect(result.segments).toEqual([]);
    expect(result.diagnostics.map((item) => item.status)).toEqual([
      "conflict_omitted",
      "conflict_omitted",
    ]);
  });

  it("maps thousands of non-overlapping segments near-linearly", () => {
    const count = 5_000;
    const pieces = Array.from({ length: count }, (_, index) =>
      piece(`ep${index}`, 0, 10, index * 10),
    );
    const source = Array.from({ length: count }, (_, index) =>
      segment({
        sourceEpisodeId: `ep${index}`,
        start: 0,
        end: 1,
        type: "recap",
      }),
    );
    const started = performance.now();
    expect(mapOutputSkipSegments(pieces, source).segments).toHaveLength(count);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
