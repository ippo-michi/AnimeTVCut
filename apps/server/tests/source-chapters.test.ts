import { describe, expect, it } from "vitest";

import {
  chapterSkipSegments,
  parseSourceChapters,
} from "../src/services/source-chapters.js";

const idaten = {
  chapters: [
    { start_time: "0", end_time: "142.141", tags: { title: "Intro" } },
    { start_time: "142.141", end_time: "232.023", tags: { title: "OP" } },
    { start_time: "232.023", end_time: "676.092", tags: { title: "Part A" } },
    { start_time: "676.092", end_time: "1281.947", tags: { title: "Part B" } },
    { start_time: "1281.947", end_time: "1372.040", tags: { title: "ED" } },
  ],
  format: { duration: "1372.040" },
};

describe("source chapter skip evidence", () => {
  it("recovers Idaten episode 4 OP/ED while preserving the cold open and story", () => {
    expect(chapterSkipSegments(parseSourceChapters(idaten), 1372.04)).toEqual([
      {
        type: "opening",
        start: 142.141,
        end: 232.023,
        provider: "source-chapters",
        sourceType: "OP",
        automaticRemoval: true,
      },
      {
        type: "ending",
        start: 1281.947,
        end: 1372.04,
        provider: "source-chapters",
        sourceType: "ED",
        automaticRemoval: true,
      },
    ]);
  });

  it("infers missing ends only from the next chapter or measured duration", () => {
    const chapters = parseSourceChapters({
      chapters: [
        { start_time: "0", tags: { title: "Opening" } },
        { start_time: "90", tags: { title: "Story" } },
        { start_time: "1282", tags: { title: "Ending Theme" } },
      ],
      format: { duration: "1372" },
    });
    expect(
      chapterSkipSegments(chapters, 1372).map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 90],
      [1282, 1372],
    ]);
    expect(
      parseSourceChapters({
        chapters: [{ start_time: "10", tags: { title: "OP" } }],
      }),
    ).toEqual([]);
  });

  it("rejects ambiguous, mixed, malformed, oversized, and out-of-duration ranges", () => {
    const chapters = [
      { start: 0, end: 90, title: "Intro" },
      { start: 0, end: 90, title: "Credits" },
      { start: 0, end: 90, title: "Opening + Story" },
      { start: 0, end: 300, title: "OP" },
      { start: -1, end: 90, title: "OP" },
      { start: 50, end: 49, title: "OP" },
      { start: 0, end: Number.NaN, title: "OP" },
      { start: 1300, end: 1400, title: "ED" },
    ];
    expect(chapterSkipSegments(chapters, 1372)).toEqual([]);
    expect(
      parseSourceChapters({
        chapters: [{ start_time: "NaN", end_time: "90" }],
      }),
    ).toEqual([]);
  });
});
