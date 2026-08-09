import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
  type EpisodeSelectionDiagnostic,
} from "./errors.js";
import type {
  CandidateFamilyMethod,
  CandidateFamilySelection,
  EpisodeCandidateSet,
  SelectedEpisodeSource,
  UnsupportedCandidateCounts,
  UrlStreamCandidate,
} from "./types.js";

const EMPTY_UNSUPPORTED_COUNTS: UnsupportedCandidateCounts = {
  torrent: 0,
  usenet: 0,
  archive: 0,
  youtube: 0,
  external: 0,
  unsupported: 0,
};

function episodeNumberFromVideoId(videoId: string): number | undefined {
  const match = /(?::|^)(\d+)$/.exec(videoId);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function normalizeFilenameFamily(
  filename: string,
  episodeNumber?: number,
): string | undefined {
  let normalized = filename
    .normalize("NFKC")
    .replace(/\.[A-Za-z0-9]{1,8}$/, "");
  normalized = normalized.replace(/\[([0-9A-Fa-f]{3,16})\](?=\s*$)/, " ");
  if (episodeNumber !== undefined) {
    const variants = new Set([
      String(episodeNumber),
      String(episodeNumber).padStart(2, "0"),
      String(episodeNumber).padStart(3, "0"),
    ]);
    for (const variant of variants) {
      normalized = normalized.replace(
        new RegExp(`(^|[\\s._-])${variant}(?=$|[\\s._-])`, "g"),
        "$1 episode ",
      );
    }
  }
  normalized = normalized.replace(
    /\bS(\d{1,2})E\d{1,3}\b/gi,
    " season $1 episode ",
  );
  normalized = normalized.replace(
    /\b(\d{1,2})x\d{1,3}\b/gi,
    " season $1 episode ",
  );
  normalized = normalized.replace(
    /\b(?:episode|ep)[ ._-]*\d{1,4}\b/gi,
    " episode ",
  );
  normalized = normalized
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length < 3 ? undefined : normalized;
}

function usableCandidates(set: EpisodeCandidateSet): UrlStreamCandidate[] {
  return set.candidates
    .filter(
      (candidate): candidate is UrlStreamCandidate => candidate.kind === "url",
    )
    .sort((left, right) => left.rank - right.rank);
}

function diagnosticFor(set: EpisodeCandidateSet): EpisodeSelectionDiagnostic {
  const usable = usableCandidates(set);
  const familyKeys = new Set<string>();
  const episodeNumber = episodeNumberFromVideoId(set.reference.videoId);
  for (const candidate of usable) {
    if (candidate.bingeGroup !== undefined)
      familyKeys.add(`b:${candidate.bingeGroup}`);
    if (candidate.filename !== undefined) {
      const key = normalizeFilenameFamily(candidate.filename, episodeNumber);
      if (key !== undefined) familyKeys.add(`f:${key}`);
    }
  }
  return {
    episodeId: set.reference.episodeId,
    upstreamResults: set.candidates.length,
    usableUrlCandidates: usable.length,
    stableFamilyCandidates: familyKeys.size,
  };
}

function countUnsupported(
  sets: readonly EpisodeCandidateSet[],
): UnsupportedCandidateCounts {
  const counts = { ...EMPTY_UNSUPPORTED_COUNTS };
  for (const candidate of sets.flatMap((set) => [...set.candidates])) {
    if (candidate.kind !== "url") counts[candidate.kind] += 1;
  }
  return counts;
}

function bestByFamily(
  set: EpisodeCandidateSet,
  method: Exclude<CandidateFamilyMethod, "mixed">,
): Map<string, UrlStreamCandidate> {
  const result = new Map<string, UrlStreamCandidate>();
  const episodeNumber = episodeNumberFromVideoId(set.reference.videoId);
  for (const candidate of usableCandidates(set)) {
    const key =
      method === "binge_group"
        ? candidate.bingeGroup
        : candidate.filename === undefined
          ? undefined
          : normalizeFilenameFamily(candidate.filename, episodeNumber);
    if (key === undefined || key.trim() === "") continue;
    const existing = result.get(key);
    if (existing === undefined || candidate.rank < existing.rank)
      result.set(key, candidate);
  }
  return result;
}

function completeFamily(
  sets: readonly EpisodeCandidateSet[],
  method: Exclude<CandidateFamilyMethod, "mixed">,
): { key: string; candidates: readonly UrlStreamCandidate[] } | undefined {
  const familiesByEpisode = sets.map((set) => bestByFamily(set, method));
  const first = familiesByEpisode[0];
  if (first === undefined) return undefined;
  const complete = [...first.keys()]
    .filter((key) => familiesByEpisode.every((families) => families.has(key)))
    .map((key) => ({
      key,
      candidates: familiesByEpisode.map((families) => families.get(key)!),
    }))
    .sort((left, right) => {
      const rankDifference =
        left.candidates.reduce((sum, candidate) => sum + candidate.rank, 0) -
        right.candidates.reduce((sum, candidate) => sum + candidate.rank, 0);
      return rankDifference !== 0
        ? rankDifference
        : left.key.localeCompare(right.key);
    });
  return complete[0];
}

function selectedEpisode(
  set: EpisodeCandidateSet,
  candidate: UrlStreamCandidate,
  method: CandidateFamilyMethod,
  familyKey: string,
): SelectedEpisodeSource {
  return {
    episodeId: set.reference.episodeId,
    upstreamType: set.reference.type,
    upstreamVideoId: set.reference.videoId,
    upstreamRank: candidate.rank,
    familyMethod: method,
    familyKey,
    mediaSource: {
      kind: "http_media",
      episodeId: set.reference.episodeId,
      url: candidate.url,
      headers: candidate.requestHeaders,
      sourceMetadata: {
        upstreamRank: candidate.rank,
        ...(candidate.filename === undefined
          ? {}
          : { filename: candidate.filename }),
        ...(candidate.videoSize === undefined
          ? {}
          : { videoSize: candidate.videoSize }),
        ...(candidate.bingeGroup === undefined
          ? {}
          : { bingeGroup: candidate.bingeGroup }),
      },
    },
    subtitles: candidate.subtitles ?? [],
    ...(candidate.videoHash === undefined
      ? {}
      : { videoHash: candidate.videoHash }),
    ...(candidate.videoSize === undefined
      ? {}
      : { videoSize: candidate.videoSize }),
    ...(candidate.filename === undefined
      ? {}
      : { filename: candidate.filename }),
  };
}

export function selectCandidateFamily(
  sets: readonly EpisodeCandidateSet[],
  options: { allowMixedSources?: boolean } = {},
): CandidateFamilySelection {
  if (sets.length === 0) {
    throw new NoConsistentStreamFamilyError([]);
  }
  const diagnostics = sets.map(diagnosticFor);
  const unusable = diagnostics.find((item) => item.usableUrlCandidates === 0);
  if (unusable !== undefined) throw new NoUsableStreamsError(unusable);
  const unsupported = countUnsupported(sets);

  for (const method of ["binge_group", "filename_family"] as const) {
    const family = completeFamily(sets, method);
    if (family !== undefined) {
      return {
        familyMethod: method,
        familyKey: family.key,
        episodes: family.candidates.map((candidate, index) =>
          selectedEpisode(sets[index]!, candidate, method, family.key),
        ),
        unsupported,
        warnings: [],
      };
    }
  }

  if (options.allowMixedSources === true) {
    return {
      familyMethod: "mixed",
      familyKey: "mixed",
      episodes: sets.map((set) =>
        selectedEpisode(set, usableCandidates(set)[0]!, "mixed", "mixed"),
      ),
      unsupported,
      warnings: ["Mixed-source mode selected unrelated upstream candidates."],
    };
  }
  throw new NoConsistentStreamFamilyError(diagnostics);
}
