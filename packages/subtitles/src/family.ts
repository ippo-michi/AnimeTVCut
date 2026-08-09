import { formatHintFromUrl, outputFormatForSources } from "./format.js";
import type {
  DiscoveredSubtitle,
  SubtitleFamily,
  SubtitleFamilyIssue,
  SubtitleSourceFormat,
} from "./types.js";

export function normalizeSubtitleLanguage(value: string): string {
  return value.trim().toLowerCase();
}
export function deduplicateSubtitles(
  items: readonly DiscoveredSubtitle[],
): DiscoveredSubtitle[] {
  const seenUrls = new Set<string>(),
    seenKeys = new Set<string>();
  return items.filter((item) => {
    let url: string;
    try {
      url = new URL(item.url).toString();
    } catch {
      return false;
    }
    const key = `${normalizeSubtitleLanguage(item.lang)}\0${item.id.trim().toLowerCase()}\0${url}`;
    if (seenUrls.has(url) || seenKeys.has(key)) return false;
    seenUrls.add(url);
    seenKeys.add(key);
    return true;
  });
}

export function matchSubtitleFamilies(
  episodeIds: readonly string[],
  subtitles: readonly DiscoveredSubtitle[],
): { families: SubtitleFamily[]; issues: SubtitleFamilyIssue[] } {
  const languages = [
      ...new Set(subtitles.map((item) => normalizeSubtitleLanguage(item.lang))),
    ].sort(),
    families: SubtitleFamily[] = [],
    issues: SubtitleFamilyIssue[] = [];
  for (const lang of languages) {
    const byEpisode = episodeIds.map((episodeId) =>
      subtitles.filter(
        (item) =>
          item.episodeId === episodeId &&
          normalizeSubtitleLanguage(item.lang) === lang,
      ),
    );
    if (byEpisode.some((items) => items.length === 0)) {
      issues.push({ lang, reason: "incomplete_family" });
      continue;
    }
    const commonIds = [
      ...new Set(byEpisode[0]!.map((item) => item.id.trim().toLowerCase())),
    ].filter(
      (id) =>
        id !== "" &&
        byEpisode.every((items) =>
          items.some((item) => item.id.trim().toLowerCase() === id),
        ),
    );
    const selections: {
      selected: DiscoveredSubtitle[];
      familyMethod: SubtitleFamily["familyMethod"];
    }[] = [];
    if (commonIds.length > 0) {
      for (const id of commonIds.sort())
        selections.push({
          selected: byEpisode.map((items) =>
            items.find((item) => item.id.trim().toLowerCase() === id)!,
          ),
          familyMethod: "exact_id",
        });
    } else if (byEpisode.every((items) => items.length === 1))
      selections.push({
        selected: byEpisode.map((items) => items[0]!),
        familyMethod: "unique_language",
      });
    else {
      issues.push({ lang, reason: "ambiguous_subtitle_family" });
      continue;
    }
    for (const { selected, familyMethod } of selections) {
      const formats = selected.map(
        (item) => item.formatHint ?? formatHintFromUrl(item.url),
      );
      if (formats.some((format) => format === undefined)) {
        issues.push({ lang, reason: "unsupported_format" });
        continue;
      }
      const outputFormat = outputFormatForSources(
        formats as SubtitleSourceFormat[],
      );
      if (outputFormat === undefined) {
        issues.push({ lang, reason: "format_family_mismatch" });
        continue;
      }
      families.push({ lang, familyMethod, outputFormat, sources: selected });
    }
  }
  return { families, issues };
}
