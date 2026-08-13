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
  options: {
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    name?: string;
  } = {},
): UrlStreamCandidate {
  return {
    kind: "url",
    rank,
    url: `https://media.test/${rank}?temporary=secret-${rank}`,
    requestHeaders: {},
    subtitles: [],
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

  it("does not confuse audio channels or bit depth with episode numbers", () => {
    expect(
      normalizeFilenameFamily(
        "Show.S01E01.1080p.WEB-DL.H264.Dual-Audio.AAC.2.0-GROUP.mkv",
        1,
      ),
    ).toBe(
      normalizeFilenameFamily(
        "Show.S01E02.1080p.WEB-DL.H264.Dual-Audio.AAC.2.0-GROUP.mkv",
        2,
      ),
    );
    expect(
      normalizeFilenameFamily(
        "Show.S01E09.1080p.BluRay.10-Bit.HEVC-GROUP.mkv",
        9,
      ),
    ).toBe(
      normalizeFilenameFamily(
        "Show.S01E10.1080p.BluRay.10-Bit.HEVC-GROUP.mkv",
        10,
      ),
    );
  });

  it("ignores episode titles and channel-layout changes within one release", () => {
    expect(
      normalizeFilenameFamily(
        "Oshi.no.Ko.S01E01.Mother.and.Children.1080p.BluRay.MULTi.Opus5.1.HEVC-DemiHuman.mkv",
        1,
      ),
    ).toBe(
      normalizeFilenameFamily(
        "Oshi.no.Ko.S01E02.Third.Option.1080p.BluRay.MULTi.Opus2.0.HEVC-DemiHuman.mkv",
        2,
      ),
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
  it("selects a complete release when a broad bingeGroup contains multiple releases", () => {
    const selection = selectCandidateFamily([
      set(1, [
        url(0, {
          bingeGroup: "broad",
          filename:
            "Oshi.no.Ko.S01E01.Mother.and.Children.1080p.BluRay.MULTi.Opus5.1.HEVC-DemiHuman.mkv",
        }),
        url(1, {
          bingeGroup: "broad",
          filename: "Oshi.no.Ko.S01E01.1080p.WEB-DL.H264-AnoZu.mkv",
        }),
      ]),
      set(2, [
        url(0, {
          bingeGroup: "broad",
          filename:
            "Oshi.no.Ko.S01E02.Third.Option.1080p.BluRay.MULTi.Opus2.0.HEVC-DemiHuman.mkv",
        }),
        url(1, {
          bingeGroup: "broad",
          filename: "Oshi.no.Ko.S01E02.1080p.WEB-DL.H264-AnoZu.mkv",
        }),
      ]),
    ]);
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      0, 0,
    ]);
  });

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

  it("selects the next complete family when one is excluded", () => {
    const sets = [
      set(1, [url(0, { bingeGroup: "A" }), url(2, { bingeGroup: "B" })]),
      set(2, [url(0, { bingeGroup: "A" }), url(2, { bingeGroup: "B" })]),
    ];
    expect(
      selectCandidateFamily(sets, {
        excludedFamilies: new Set(["binge_group:A"]),
      }).familyKey,
    ).toBe("B");
  });

  it("retries another candidate without discarding its whole family", () => {
    const sets = [
      set(1, [url(0, { bingeGroup: "A" }), url(1, { bingeGroup: "A" })]),
      set(2, [url(0, { bingeGroup: "A" }), url(1, { bingeGroup: "A" })]),
    ];
    const selection = selectCandidateFamily(sets, {
      excludedCandidates: new Set(["ep1:0", "ep2:0"]),
    });
    expect(selection.familyKey).toBe("A");
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      1, 1,
    ]);
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

  it("does not mix release families hidden behind one broad bingeGroup", () => {
    const selection = selectCandidateFamily([
      set(1, [
        url(0, { bingeGroup: "broad", filename: "Alpha.Show.S01E01.mkv" }),
        url(1, { bingeGroup: "broad", filename: "Beta.Show.S01E01.mkv" }),
      ]),
      set(2, [
        url(0, { bingeGroup: "broad", filename: "Beta.Show.S01E02.mkv" }),
        url(1, { bingeGroup: "broad", filename: "Alpha.Show.S01E02.mkv" }),
      ]),
    ]);
    expect(
      selection.episodes.map((episode) => episode.filename?.split(".", 1)[0]),
    ).toEqual(["Alpha", "Alpha"]);
  });

  it("rejects a candidate whose explicit filename coordinates mismatch", () => {
    const selection = selectCandidateFamily([
      set(1, [url(0, { bingeGroup: "A", filename: "Show.S01E01.mkv" })]),
      set(2, [
        url(0, { bingeGroup: "A", filename: "Show.S04E02.mkv" }),
        url(4, { bingeGroup: "A", filename: "Show.S01E02.mkv" }),
      ]),
    ]);
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      0, 4,
    ]);
  });

  it("prefers a small H.264 Japanese family for MediaFlow normalization", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "hevc",
            filename: "Show.S01E01.1080p.x265.mkv",
            videoSize: 4_000_000_000,
          }),
          url(8, {
            bingeGroup: "web",
            filename: "Show.S01E01.1080p.H264.Japanese.mkv",
            videoSize: 900_000_000,
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "hevc",
            filename: "Show.S01E02.1080p.x265.mkv",
            videoSize: 4_000_000_000,
          }),
          url(8, {
            bingeGroup: "web",
            filename: "Show.S01E02.1080p.H264.Japanese.mkv",
            videoSize: 900_000_000,
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );
    expect(selection.familyKey).toBe("web");
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      8, 8,
    ]);
  });

  it("does not mistake AVC Hi10 for a remux-compatible H.264 family", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "hi10",
            filename: "Show.S01E01.1080p.AVC.Hi10.FLAC.Japanese.mkv",
          }),
          url(5, {
            bingeGroup: "remux",
            filename: "Show.S01E01.1080p.H264.AAC.Japanese.mkv",
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "hi10",
            filename: "Show.S01E02.1080p.AVC.10bit.FLAC.Japanese.mkv",
          }),
          url(5, {
            bingeGroup: "remux",
            filename: "Show.S01E02.1080p.H264.AAC.Japanese.mkv",
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );

    expect(selection.familyKey).toBe("remux");
    expect(selection.episodes.map((episode) => episode.upstreamRank)).toEqual([
      5, 5,
    ]);
  });

  it("prefers AAC when otherwise equivalent H.264 families are available", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "flac",
            filename: "Show.S01E01.1080p.H264.FLAC.Japanese.mkv",
          }),
          url(4, {
            bingeGroup: "aac",
            filename: "Show.S01E01.1080p.H264.AAC2.0.Japanese.mkv",
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "flac",
            filename: "Show.S01E02.1080p.H264.FLAC.Japanese.mkv",
          }),
          url(4, {
            bingeGroup: "aac",
            filename: "Show.S01E02.1080p.H264.AAC2.0.Japanese.mkv",
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );

    expect(selection.familyKey).toBe("aac");
  });

  it("prefers an unlabelled 1080p anime release over 2160p", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "uhd",
            filename: "Show.S01E01.2160p.H264.AAC.Japanese.mkv",
          }),
          url(8, {
            bingeGroup: "hd",
            filename: "Show.S01E01.1080p.CR.WEB-DL.H264.AAC.mkv",
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "uhd",
            filename: "Show.S01E02.2160p.H264.AAC.Japanese.mkv",
          }),
          url(8, {
            bingeGroup: "hd",
            filename: "Show.S01E02.1080p.CR.WEB-DL.H264.AAC.mkv",
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );

    expect(selection.familyKey).toBe("hd");
  });

  it("does not prefer an explicitly English-only 1080p family", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "dub",
            filename: "Show.S01E01.1080p.H264.AAC.English-Dub.mkv",
          }),
          url(5, {
            bingeGroup: "sub",
            filename: "Show.S01E01.2160p.H264.AAC.Japanese.mkv",
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "dub",
            filename: "Show.S01E02.1080p.H264.AAC.English-Dub.mkv",
          }),
          url(5, {
            bingeGroup: "sub",
            filename: "Show.S01E02.2160p.H264.AAC.Japanese.mkv",
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );

    expect(selection.familyKey).toBe("sub");
  });

  it("does not treat a dual-track FLAC/AAC BD remux as AAC-only", () => {
    const selection = selectCandidateFamily(
      [
        set(1, [
          url(0, {
            bingeGroup: "bluray",
            filename: "Show.S01E01.1080p.BD.Remux.AVC.FLAC.AAC.Dual-Audio.mkv",
          }),
          url(9, {
            bingeGroup: "web",
            filename: "Show.S01E01.1080p.WEB-DL.H264.AAC.Japanese.mkv",
          }),
        ]),
        set(2, [
          url(0, {
            bingeGroup: "bluray",
            filename: "Show.S01E02.1080p.BD.Remux.AVC.FLAC.AAC.Dual-Audio.mkv",
          }),
          url(9, {
            bingeGroup: "web",
            filename: "Show.S01E02.1080p.WEB-DL.H264.AAC.Japanese.mkv",
          }),
        ]),
      ],
      { preferMediaFlowCompatible: true },
    );

    expect(selection.familyKey).toBe("web");
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
