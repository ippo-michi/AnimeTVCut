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

function filenameMatchesEpisode(set: EpisodeCandidateSet, filename?: string) {
  if (filename === undefined) return true;
  const coordinates =
    /\bS(\d{1,2})E(\d{1,3})\b/i.exec(filename) ??
    /\b(\d{1,2})x(\d{1,3})\b/i.exec(filename);
  if (coordinates === null) return true;
  const videoCoordinates = /^tt\d{7,8}:(\d+):(\d+)$/.exec(
    set.reference.videoId,
  );
  const expectedSeason =
    set.reference.skipIdentity?.imdbSeason ??
    (videoCoordinates?.[1] === undefined
      ? undefined
      : Number(videoCoordinates[1]));
  const expectedEpisode =
    set.reference.skipIdentity?.imdbEpisode ??
    (videoCoordinates?.[2] === undefined
      ? episodeNumberFromVideoId(set.reference.videoId)
      : Number(videoCoordinates[2]));
  if (expectedSeason === undefined || expectedEpisode === undefined)
    return true;
  return (
    Number(coordinates[1]) === expectedSeason &&
    Number(coordinates[2]) === expectedEpisode
  );
}

export function normalizeFilenameFamily(
  filename: string,
  episodeNumber?: number,
): string | undefined {
  let normalized = filename
    .normalize("NFKC")
    .replace(/\.[A-Za-z0-9]{1,8}$/, "");
  normalized = normalized.replace(/\[([0-9A-Fa-f]{3,16})\](?=\s*$)/, " ");
  normalized = normalized.replace(
    /\bS(\d{1,2})E\d{1,3}\b/gi,
    " season $1 episode ",
  );
  normalized = normalized.replace(
    /\b(\d{1,2})x\d{1,3}\b/gi,
    " season $1 episode ",
  );
  normalized = normalized.replace(
    /\b(?:episode|ep)[ ._-]*\d{1,4}(?:v\d+)?\b/gi,
    " episode ",
  );
  if (episodeNumber !== undefined) {
    const variants = [
      String(episodeNumber).padStart(3, "0"),
      String(episodeNumber).padStart(2, "0"),
      String(episodeNumber),
    ];
    // Absolute-number anime releases conventionally separate the episode with
    // a dash ("Show - 02" or "Show - 02v2"). Do not replace arbitrary bare
    // numbers: episode 2 must not rewrite AAC 2.0, and episode 10 must not
    // rewrite 10-bit codec metadata.
    normalized = normalized.replace(
      new RegExp(
        `(^|\\s)-[\\s._-]*(?:${variants.join("|")})(?:v\\d+)?(?=$|[\\s._([{])`,
        "gi",
      ),
      "$1 episode ",
    );
  }
  const technicalMarker =
    "(?:4320p|2160p|1440p|1080p|720p|576p|480p|blu[ ._-]?ray|bd(?:rip|remux)?|web[ ._-]?(?:dl|rip)|h[ ._-]?26[45]|x26[45]|avc|hevc|av1)";
  normalized = normalized.replace(
    new RegExp(
      `\\bepisode\\b(?:[ ._-]+(?!${technicalMarker}\\b)[\\p{L}\\p{N}'’]+)+(?=[ ._-]+${technicalMarker}\\b)`,
      "giu",
    ),
    " episode ",
  );
  normalized = normalized.replace(
    /(\b(?:aac(?:[ ._-]?lc)?|opus|flac|pcm|e[ ._-]?ac[ ._-]?3|ac[ ._-]?3|ddp|dts(?:[ ._-]?hd)?|truehd))\s*\d(?:[ ._-]*\d)?(?=$|[\s)\]}._-])/gi,
    "$1 ",
  );
  normalized = normalized
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length < 3 ? undefined : normalized;
}

function candidateExclusionKey(
  set: EpisodeCandidateSet,
  candidate: UrlStreamCandidate,
): string {
  return `${set.reference.episodeId}:${candidate.rank}`;
}

function usableCandidates(
  set: EpisodeCandidateSet,
  excludedCandidates: ReadonlySet<string> = new Set(),
): UrlStreamCandidate[] {
  return set.candidates
    .filter(
      (candidate): candidate is UrlStreamCandidate =>
        candidate.kind === "url" &&
        filenameMatchesEpisode(set, candidate.filename) &&
        !excludedCandidates.has(candidateExclusionKey(set, candidate)),
    )
    .sort((left, right) => left.rank - right.rank);
}

interface NormalizationScore {
  codec: number;
  audio: number;
  englishOnly: number;
  japaneseAudio: number;
  delivery: number;
  resolution: number;
  size: number;
  rank: number;
}

function normalizationScore(candidate: UrlStreamCandidate): NormalizationScore {
  const text = `${candidate.name ?? ""} ${candidate.filename ?? ""}`;
  const compatible = /(?:\bAVC\b|\bH[ ._-]?264\b|\bx264\b)/i.test(text);
  const expensive =
    /(?:\bHEVC\b|\bH[ ._-]?265\b|\bx265\b|\bAV1\b|\bHi10\b|\b10[ ._-]?bit\b)/i.test(
      text,
    );
  const aac = /(?:\bAAC\b|\bAAC[ ._-]?(?:LC|2(?:[ ._-]?0)?))/i.test(text);
  const expensiveAudio =
    /(?:\bFLAC\b|\bTrueHD\b|\bDTS(?:[ ._-]?HD)?\b|\bE[ ._-]?AC[ ._-]?3\b|\bAC[ ._-]?3\b)/i.test(
      text,
    );
  const japanese = /(?:\bJPN\b|\bJapanese\b|🇯🇵)/i.test(text);
  const dualAudio = /\bdual[ ._-]?audio\b/i.test(text);
  const englishOnly =
    !japanese &&
    !dualAudio &&
    /(?:\bENG\b|\bEnglish(?:[ ._-]?Dub(?:bed)?)?\b)/i.test(text);
  const resolution = /(?:\b2160p\b|\b4k\b)/i.test(text)
    ? 2
    : /\b1080p\b/i.test(text)
      ? 0
      : 1;
  const delivery = /(?:\bWEB[ ._-]?DL\b|\bWEBRip\b)/i.test(text)
    ? 0
    : /(?:\bBD[ ._-]?Remux\b|\bRemux\b)/i.test(text)
      ? 2
      : 1;
  return {
    // AVC Hi10/10-bit still requires transcoding. Check the incompatible
    // markers first so a filename containing both "AVC" and "Hi10" cannot
    // accidentally win the remux preference.
    codec: expensive ? 2 : compatible ? 0 : 1,
    audio: expensiveAudio ? 2 : aac ? 0 : 1,
    englishOnly: englishOnly ? 2 : 0,
    // Unlabelled anime releases remain eligible: MediaFlow still selects a
    // Japanese track by Matroska language metadata when one exists.
    japaneseAudio: japanese || dualAudio ? 0 : englishOnly ? 2 : 1,
    delivery,
    resolution,
    size: candidate.videoSize ?? Number.MAX_SAFE_INTEGER,
    rank: candidate.rank,
  };
}

function compareScore(
  left: NormalizationScore,
  right: NormalizationScore,
): number {
  return (
    left.codec - right.codec ||
    left.audio - right.audio ||
    left.englishOnly - right.englishOnly ||
    left.delivery - right.delivery ||
    left.resolution - right.resolution ||
    left.japaneseAudio - right.japaneseAudio ||
    left.size - right.size ||
    left.rank - right.rank
  );
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
  preferMediaFlowCompatible: boolean,
  excludedCandidates: ReadonlySet<string>,
): Map<string, UrlStreamCandidate> {
  const result = new Map<string, UrlStreamCandidate>();
  const episodeNumber = episodeNumberFromVideoId(set.reference.videoId);
  const usable = usableCandidates(set, excludedCandidates);
  const filenameFamiliesByBingeGroup = new Map<string, Set<string>>();
  for (const candidate of usable) {
    if (candidate.bingeGroup === undefined || candidate.filename === undefined)
      continue;
    const filenameFamily = normalizeFilenameFamily(
      candidate.filename,
      episodeNumber,
    );
    if (filenameFamily === undefined) continue;
    const families =
      filenameFamiliesByBingeGroup.get(candidate.bingeGroup) ?? new Set();
    families.add(filenameFamily);
    filenameFamiliesByBingeGroup.set(candidate.bingeGroup, families);
  }
  for (const candidate of usable) {
    const filenameFamily =
      candidate.filename === undefined
        ? undefined
        : normalizeFilenameFamily(candidate.filename, episodeNumber);
    const key =
      method === "binge_group"
        ? candidate.bingeGroup === undefined
          ? undefined
          : (filenameFamiliesByBingeGroup.get(candidate.bingeGroup)?.size ??
                0) > 1
            ? filenameFamily === undefined
              ? undefined
              : `${candidate.bingeGroup}\u0000${filenameFamily}`
            : candidate.bingeGroup
        : filenameFamily;
    if (key === undefined || key.trim() === "") continue;
    const existing = result.get(key);
    if (
      existing === undefined ||
      (preferMediaFlowCompatible
        ? compareScore(
            normalizationScore(candidate),
            normalizationScore(existing),
          ) < 0
        : candidate.rank < existing.rank)
    )
      result.set(key, candidate);
  }
  return result;
}

function completeFamily(
  sets: readonly EpisodeCandidateSet[],
  method: Exclude<CandidateFamilyMethod, "mixed">,
  preferMediaFlowCompatible: boolean,
  excludedFamilies: ReadonlySet<string>,
  excludedCandidates: ReadonlySet<string>,
): { key: string; candidates: readonly UrlStreamCandidate[] } | undefined {
  const familiesByEpisode = sets.map((set) =>
    bestByFamily(set, method, preferMediaFlowCompatible, excludedCandidates),
  );
  const first = familiesByEpisode[0];
  if (first === undefined) return undefined;
  const complete = [...first.keys()]
    .filter((key) => familiesByEpisode.every((families) => families.has(key)))
    .filter((key) => !excludedFamilies.has(`${method}:${key}`))
    .map((key) => ({
      key,
      candidates: familiesByEpisode.map((families) => families.get(key)!),
    }))
    .sort((left, right) => {
      if (preferMediaFlowCompatible) {
        const sum = (candidates: readonly UrlStreamCandidate[]) =>
          candidates.reduce(
            (total, candidate) => {
              const score = normalizationScore(candidate);
              return {
                codec: total.codec + score.codec,
                audio: total.audio + score.audio,
                englishOnly: total.englishOnly + score.englishOnly,
                japaneseAudio: total.japaneseAudio + score.japaneseAudio,
                delivery: total.delivery + score.delivery,
                resolution: total.resolution + score.resolution,
                size: total.size + score.size,
                rank: total.rank + score.rank,
              };
            },
            {
              codec: 0,
              audio: 0,
              englishOnly: 0,
              japaneseAudio: 0,
              delivery: 0,
              resolution: 0,
              size: 0,
              rank: 0,
            },
          );
        const scoreDifference = compareScore(
          sum(left.candidates),
          sum(right.candidates),
        );
        if (scoreDifference !== 0) return scoreDifference;
      }
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
  options: {
    allowMixedSources?: boolean;
    preferMediaFlowCompatible?: boolean;
    excludedFamilies?: ReadonlySet<string>;
    excludedCandidates?: ReadonlySet<string>;
  } = {},
): CandidateFamilySelection {
  if (sets.length === 0) {
    throw new NoConsistentStreamFamilyError([]);
  }
  const diagnostics = sets.map(diagnosticFor);
  const unusable = diagnostics.find((item) => item.usableUrlCandidates === 0);
  if (unusable !== undefined) throw new NoUsableStreamsError(unusable);
  const unsupported = countUnsupported(sets);

  for (const method of ["binge_group", "filename_family"] as const) {
    const family = completeFamily(
      sets,
      method,
      options.preferMediaFlowCompatible ?? false,
      options.excludedFamilies ?? new Set(),
      options.excludedCandidates ?? new Set(),
    );
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
        selectedEpisode(
          set,
          usableCandidates(set, options.excludedCandidates)[0]!,
          "mixed",
          "mixed",
        ),
      ),
      unsupported,
      warnings: ["Mixed-source mode selected unrelated upstream candidates."],
    };
  }
  throw new NoConsistentStreamFamilyError(diagnostics);
}
