import type { TimelinePiece } from "../models/ranges.js";

const EPSILON = 1e-7;

export type OutputSkipSegmentType = "intro" | "outro" | "recap" | "preview";
export type OutputSkipSegmentReason =
  "policy_kept" | "alignment_retained" | "partially_retained";

export interface SafeSourceSkipSegment {
  sourceEpisodeId: string;
  type: "opening" | "ending" | "recap" | "preview";
  start: number;
  end: number;
  decision: "keep" | "remove";
}

export interface OutputSkipSegment {
  id: string;
  type: OutputSkipSegmentType;
  start: number;
  end: number;
  title: string;
  reason: OutputSkipSegmentReason;
}

export interface OutputSkipDiagnostic {
  sourceIndex: number;
  type: OutputSkipSegmentType;
  decision: "keep" | "remove";
  sourceStart: number;
  sourceEnd: number;
  removalRequested: boolean;
  status: "mapped" | "fully_removed" | "conflict_omitted";
  retainedFragments: number;
  outputRanges: readonly { start: number; end: number }[];
  reason?: OutputSkipSegmentReason;
}

export interface OutputSkipMappingResult {
  segments: readonly OutputSkipSegment[];
  diagnostics: readonly OutputSkipDiagnostic[];
}

interface MappedFragment {
  sourceIndex: number;
  type: OutputSkipSegmentType;
  start: number;
  end: number;
  reason: OutputSkipSegmentReason;
}

const TYPE_DETAILS: Readonly<
  Record<
    SafeSourceSkipSegment["type"],
    { type: OutputSkipSegmentType; title: string }
  >
> = {
  opening: { type: "intro", title: "Skip Intro" },
  ending: { type: "outro", title: "Skip Outro" },
  recap: { type: "recap", title: "Skip Recap" },
  preview: { type: "preview", title: "Skip Preview" },
};

function indexPieces(
  pieces: readonly TimelinePiece[],
): ReadonlyMap<string, readonly TimelinePiece[]> {
  const result = new Map<string, TimelinePiece[]>();
  for (const piece of pieces) {
    const episode = result.get(piece.sourceEpisodeId) ?? [];
    episode.push(piece);
    result.set(piece.sourceEpisodeId, episode);
  }
  return result;
}

function mergeContiguous(
  fragments: readonly Omit<MappedFragment, "reason">[],
): Omit<MappedFragment, "reason">[] {
  const result: Omit<MappedFragment, "reason">[] = [];
  for (const fragment of fragments) {
    const previous = result.at(-1);
    if (
      previous !== undefined &&
      previous.sourceIndex === fragment.sourceIndex &&
      previous.type === fragment.type &&
      fragment.start <= previous.end + EPSILON
    ) {
      previous.end = Math.max(previous.end, fragment.end);
    } else {
      result.push({ ...fragment });
    }
  }
  return result;
}

export function mapOutputSkipSegments(
  pieces: readonly TimelinePiece[],
  sourceSegments: readonly SafeSourceSkipSegment[],
): OutputSkipMappingResult {
  const piecesByEpisode = indexPieces(pieces);
  const diagnostics: OutputSkipDiagnostic[] = [];
  const fragments: MappedFragment[] = [];
  const seen = new Set<string>();

  for (const [sourceIndex, source] of sourceSegments.entries()) {
    if (
      !Number.isFinite(source.start) ||
      !Number.isFinite(source.end) ||
      source.start < 0 ||
      source.end <= source.start
    ) {
      continue;
    }
    const duplicateKey = [
      source.sourceEpisodeId,
      source.type,
      source.start,
      source.end,
      source.decision,
    ].join("\0");
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);

    const details = TYPE_DETAILS[source.type];
    const mapped = mergeContiguous(
      (piecesByEpisode.get(source.sourceEpisodeId) ?? []).flatMap((piece) => {
        const intersectionStart = Math.max(source.start, piece.sourceStart);
        const intersectionEnd = Math.min(source.end, piece.sourceEnd);
        if (intersectionEnd <= intersectionStart + EPSILON) return [];
        return [
          {
            sourceIndex,
            type: details.type,
            start: piece.outputStart + (intersectionStart - piece.sourceStart),
            end: piece.outputStart + (intersectionEnd - piece.sourceStart),
          },
        ];
      }),
    );
    if (mapped.length === 0) {
      diagnostics.push({
        sourceIndex,
        type: details.type,
        decision: source.decision,
        sourceStart: source.start,
        sourceEnd: source.end,
        removalRequested: source.decision === "remove",
        status: "fully_removed",
        retainedFragments: 0,
        outputRanges: [],
      });
      continue;
    }
    const retainedDuration = mapped.reduce(
      (total, item) => total + (item.end - item.start),
      0,
    );
    const fullyRetained =
      Math.abs(retainedDuration - (source.end - source.start)) <= EPSILON;
    const reason: OutputSkipSegmentReason = fullyRetained
      ? source.decision === "keep"
        ? "policy_kept"
        : "alignment_retained"
      : "partially_retained";
    diagnostics.push({
      sourceIndex,
      type: details.type,
      decision: source.decision,
      sourceStart: source.start,
      sourceEnd: source.end,
      removalRequested: source.decision === "remove",
      status: "mapped",
      retainedFragments: mapped.length,
      outputRanges: mapped.map(({ start, end }) => ({ start, end })),
      reason,
    });
    fragments.push(...mapped.map((item) => ({ ...item, reason })));
  }

  fragments.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const conflicts = new Set<number>();
  let cluster: MappedFragment[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  const flushCluster = () => {
    if (cluster.length > 1) {
      for (const fragment of cluster) conflicts.add(fragment.sourceIndex);
    }
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };
  for (const current of fragments) {
    if (cluster.length === 0 || current.start < clusterEnd - EPSILON) {
      cluster.push(current);
      clusterEnd = Math.max(clusterEnd, current.end);
    } else {
      flushCluster();
      cluster.push(current);
      clusterEnd = current.end;
    }
  }
  flushCluster();
  for (const diagnostic of diagnostics) {
    if (conflicts.has(diagnostic.sourceIndex)) {
      diagnostic.status = "conflict_omitted";
      diagnostic.reason = undefined;
    }
  }

  const safe = fragments.filter(
    (fragment) => !conflicts.has(fragment.sourceIndex),
  );
  const width = Math.max(2, String(safe.length).length);
  return {
    segments: safe.map((fragment, index) => ({
      id: `s${String(index + 1).padStart(width, "0")}`,
      type: fragment.type,
      start: fragment.start,
      end: fragment.end,
      title:
        fragment.type === "intro"
          ? "Skip Intro"
          : fragment.type === "outro"
            ? "Skip Outro"
            : fragment.type === "recap"
              ? "Skip Recap"
              : "Skip Preview",
      reason: fragment.reason,
    })),
    diagnostics,
  };
}
