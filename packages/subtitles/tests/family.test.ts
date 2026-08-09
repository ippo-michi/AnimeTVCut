import { describe, expect, it } from "vitest";
import {
  deduplicateSubtitles,
  matchSubtitleFamilies,
  type DiscoveredSubtitle,
} from "../src/index.js";
const item = (
  episodeId: string,
  id: string,
  lang = "eng",
  ext = "srt",
): DiscoveredSubtitle => ({
  episodeId,
  id,
  lang,
  url: `https://subs.test/${episodeId}-${id}.${ext}`,
  source: "stream",
});
describe("subtitle family matching", () => {
  it("prefers an exact ID and treats language case conservatively", () => {
    const result = matchSubtitleFamilies(
      ["e1", "e2", "e3"],
      [
        item("e1", "full", "ENG"),
        item("e1", "signs"),
        item("e2", "full"),
        item("e2", "signs"),
        item("e3", "full"),
        item("e3", "signs"),
      ],
    );
    expect(result.families[0]).toMatchObject({
      lang: "eng",
      familyMethod: "exact_id",
    });
  });
  it("uses unique-language fallback", () => {
    expect(
      matchSubtitleFamilies(["e1", "e2"], [item("e1", "a"), item("e2", "b")])
        .families[0]?.familyMethod,
    ).toBe("unique_language");
  });
  it.each([
    [
      [item("e1", "a"), item("e1", "b"), item("e2", "c"), item("e2", "d")],
      "ambiguous_subtitle_family",
    ],
    [[item("e1", "a")], "incomplete_family"],
    [
      [item("e1", "a", "eng", "ass"), item("e2", "a")],
      "format_family_mismatch",
    ],
    [
      [item("e1", "a", "eng", "bin"), item("e2", "a", "eng", "bin")],
      "unsupported_format",
    ],
  ])("omits unsafe family: %s", (items, reason) => {
    const result = matchSubtitleFamilies(
      ["e1", "e2"],
      items as DiscoveredSubtitle[],
    );
    expect(result.families).toEqual([]);
    expect(result.issues[0]?.reason).toBe(reason);
  });
  it("deduplicates exact URLs across stream and resource results", () => {
    const value = item("e1", "full");
    expect(
      deduplicateSubtitles([value, { ...value, source: "subtitle_resource" }]),
    ).toHaveLength(1);
  });
});
