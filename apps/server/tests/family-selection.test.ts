import { describe, expect, it } from "vitest";

import {
  normalizeFilenameFamily,
  selectCandidateFamily,
} from "../src/services/stremio-upstream/family-selection.js";
import type {
  EpisodeCandidateSet,
  StremioStreamCandidate,
  UrlStreamCandidate,
} from "../src/services/stremio-upstream/types.js";

function url(
  rank: number,
  options: { bingeGroup?: string; filename?: string; videoSize?: number } = {},
): UrlStreamCandidate {
  return {
    kind: "url",
    rank,
    url: `https://media.test/${rank}?temporary=secret-${rank}`,
    requestHeaders: {},
    ...options,
  };
}

function set(
  episode: number,
  candidates: readonly StremioStreamCandidate[],
): EpisodeCandidateSet {
  return {
    reference: {
      episodeId: `ep${episode}`,
      type: "series",
      videoId: `tt1234567:1:${episode}`,
    },
    candidates,
  };
}

describe("filename-family normalization", () => {
  it("matches SxxExx filenames while preserving release characteristics", () => {
    expect(
      normalizeFilenameFamily("Show.S01E01.1080p.WEB-DL.H264-GROUP.mkv", 1),
    ).toBe(
      normalizeFilenameFamily("Show.S01E02.1080p.WEB-DL.H264-GROUP.mkv", 2),
    );
  });

  it("matches conservative anime episode numbers and trailing checksums", () => {
    expect(
      normalizeFilenameFamily("[SubsPlease] Frieren - 01 (1080p) [ABC].mkv", 1),
    ).toBe(
      normalizeFilenameFamily("[SubsPlease] Frieren - 02 (1080p) [DEF].mkv", 2),
    );
  });

  it("supports 1x02, Episode 02, and Ep02 forms", () => {
    const expected = normalizeFilenameFamily("Show.1x01.1080p-GROUP.mkv", 1);
    expect(normalizeFilenameFamily("Show.1x02.1080p-GROUP.mkv", 2)).toBe(
      expected,
    );
    expect(normalizeFilenameFamily("Show Episode 03 1080p-GROUP.mkv", 3)).toBe(
      normalizeFilenameFamily("Show Episode 04 1080p-GROUP.mkv", 4),
    );
    expect(normalizeFilenameFamily("Show Ep05 1080p-GROUP.mkv", 5)).toBe(
      normalizeFilenameFamily("Show Ep06 1080p-GROUP.mkv", 6),
    );
  });

  it("does not merge different groups or resolutions", () => {
    expect(normalizeFilenameFamily("[GroupA] Show - 01.mkv", 1)).not.toBe(
      normalizeFilenameFamily("[GroupB] Show - 02.mkv", 2),
    );
    expect(normalizeFilenameFamily("Show.S01E01.1080p-GROUP.mkv", 1)).not.toBe(
      normalizeFilenameFamily("Show.S01E02.720p-GROUP.mkv", 2),
    );
  });
});

describe("cross-episode candidate family selection", () => {
  it("selects an exact complete bingeGroup instead of independent rank zero", () => {
    const selection = selectCandidateFamily([
      set(1, [url(0, { bingeGroup: "B" }), url(1, { bingeGroup: "A" })]),
      set(2, [url(0, { bingeGroup: "A" }), url(1, { bingeGroup: "B" })]),
      set(3, [url(0, { bingeGroup: "A" }), url(1, { bingeGroup: "B" })]),
    ]);
    expect(selection.familyMethod).toBe("binge_group");
    expect(selection.familyKey).toBe("A");
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      1, 0, 0,
    ]);
  });

  it("chooses the complete bingeGroup with the lowest total rank", () => {
    const selection = selectCandidateFamily([
      set(1, [url(0, { bingeGroup: "B" }), url(2, { bingeGroup: "A" })]),
      set(2, [url(0, { bingeGroup: "A" }), url(3, { bingeGroup: "B" })]),
      set(3, [url(0, { bingeGroup: "A" }), url(3, { bingeGroup: "B" })]),
    ]);
    expect(selection.familyKey).toBe("A");
  });

  it("uses the best duplicate candidate for a family within each episode", () => {
    const selection = selectCandidateFamily([
      set(1, [url(5, { bingeGroup: "A" }), url(1, { bingeGroup: "A" })]),
      set(2, [url(2, { bingeGroup: "A" })]),
    ]);
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      1, 2,
    ]);
  });

  it("falls back to filename families without using video size as identity", () => {
    const selection = selectCandidateFamily([
      set(1, [
        url(0, { filename: "Show.S01E01.1080p-GROUP.mkv", videoSize: 100 }),
      ]),
      set(2, [
        url(1, { filename: "Show.S01E02.1080p-GROUP.mkv", videoSize: 200 }),
      ]),
    ]);
    expect(selection.familyMethod).toBe("filename_family");
  });

  it("fails when filename and bingeGroup are both missing", () => {
    expect(() =>
      selectCandidateFamily([set(1, [url(0)]), set(2, [url(0)])]),
    ).toThrow(/No consistent stream family/);
  });

  it("distinguishes no usable URL streams from no upstream results", () => {
    expect(() =>
      selectCandidateFamily([
        set(1, [
          { kind: "torrent", rank: 0, reason: "unsupported" },
          { kind: "usenet", rank: 1, reason: "unsupported" },
        ]),
      ]),
    ).toThrow(/had 2 upstream results but none were HTTP\(S\)/);
  });

  it("fails by default when there is no complete family", () => {
    expect(() =>
      selectCandidateFamily([
        set(1, [url(0, { bingeGroup: "A" })]),
        set(2, [url(0, { bingeGroup: "B" })]),
      ]),
    ).toThrow(/No consistent stream family/);
  });

  it("supports explicit mixed-source fallback with a warning", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [url(1, { bingeGroup: "A" }), url(0)]),
        set(2, [url(0, { bingeGroup: "B" })]),
      ],
      { allowMixedSources: true },
    );
    expect(selection.familyMethod).toBe("mixed");
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      0, 0,
    ]);
    expect(selection.warnings).toHaveLength(1);
  });
});
