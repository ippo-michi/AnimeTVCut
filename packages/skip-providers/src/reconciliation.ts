import type {
  ReconciledSkipSegment,
  SkipProviderResult,
  SkipSegment,
  SkipSegmentProvider,
} from "./models.js";

const STRONG_OVERLAP_RATIO = 0.8;
const CORROBORATED_OPEN_START_TOLERANCE_SECONDS = 15;
const OPEN_ENDED_ESTIMATE_SECONDS = 90;

const ESTIMATABLE_TYPES = new Set<SkipSegment["type"]>([
  "opening",
  "ending",
  "preview",
]);

function stronglyOverlaps(left: SkipSegment, right: SkipSegment): boolean {
  if (left.end === null || right.end === null || left.type !== right.type) {
    return false;
  }
  const overlap = Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
  const shorter = Math.min(left.end - left.start, right.end - right.start);
  return shorter > 0 && overlap / shorter >= STRONG_OVERLAP_RATIO;
}

function estimateBoundedSegment(
  segment: SkipSegment & { end: null },
  durationSeconds: number,
): (SkipSegment & { end: number }) | null {
  const estimatedEnd = segment.start + OPEN_ENDED_ESTIMATE_SECONDS;
  const clampedEnd = Math.min(estimatedEnd, durationSeconds);
  if (segment.start >= durationSeconds) {
    return null;
  }
  return {
    ...segment,
    end: clampedEnd,
    automaticRemoval: true,
    unsafeReason: undefined,
  };
}

export function reconcileSkipSegments(
  results: readonly SkipProviderResult[],
  providers: readonly SkipSegmentProvider[],
  durationSeconds = Number.MAX_SAFE_INTEGER,
): { segments: ReconciledSkipSegment[]; warnings: string[] } {
  const reports = results.flatMap((result) => [...result.segments]);
  const warnings: string[] = [];

  const boundedSafe = reports.filter(
    (segment): segment is SkipSegment & { end: number } =>
      segment.automaticRemoval && segment.end !== null,
  );
  const openEndedSegments = reports.filter((segment) => segment.end === null);

  const estimatedStarts = new Set<string>();
  const estimatedSegments: (SkipSegment & { end: number })[] = [];
  for (const segment of openEndedSegments) {
    if (ESTIMATABLE_TYPES.has(segment.type)) {
      const estimated = estimateBoundedSegment(
        segment as SkipSegment & { end: null },
        durationSeconds,
      );
      if (estimated !== null) {
        const key = `${segment.provider}:${segment.type}:${segment.start}`;
        const alreadyExists = estimatedSegments.some(
          (existing) =>
            existing.start === estimated.start &&
            existing.end === estimated.end &&
            existing.provider === estimated.provider,
        );
        if (!alreadyExists) {
          estimatedSegments.push(estimated);
          estimatedStarts.add(key);
        }
      }
    }
  }

  const safeWithCorroboration = boundedSafe.map((segment) => {
    const corroboratingStart = openEndedSegments
      .filter(
        (candidate) =>
          candidate.type === segment.type &&
          candidate.provider !== segment.provider &&
          candidate.start < segment.start &&
          segment.start - candidate.start <=
            CORROBORATED_OPEN_START_TOLERANCE_SECONDS,
      )
      .sort((left, right) => right.start - left.start)[0];
    if (corroboratingStart === undefined) return segment;
    warnings.push(
      `Used a corroborating ${corroboratingStart.provider} ${segment.type} start with the bounded ${segment.provider} ${segment.type} range.`,
    );
    return { ...segment, start: corroboratingStart.start };
  });

  const safePool = [...safeWithCorroboration, ...estimatedSegments];
  const canonical: ReconciledSkipSegment[] = [];
  for (const segment of safePool) {
    const matchingIndex = canonical.findIndex((existing) =>
      stronglyOverlaps(existing, segment),
    );
    if (matchingIndex !== -1) {
      const existing = canonical[matchingIndex]!;
      canonical[matchingIndex] = {
        ...existing,
        alternatives: [
          ...(existing.alternatives ?? []),
          {
            provider: segment.provider,
            start: segment.start,
            end: segment.end,
          },
        ],
      };
      continue;
    }
    canonical.push({ ...segment });
  }

  for (const type of ["opening", "ending"] as const) {
    const distinct = canonical.filter((segment) => segment.type === type);
    const providerCount = new Set(distinct.map((segment) => segment.provider))
      .size;
    if (distinct.length > 1 && providerCount > 1) {
      warnings.push(
        `Providers reported conflicting non-overlapping ${type} ranges.`,
      );
    }
  }

  const unsafe = openEndedSegments
    .filter(
      (segment) =>
        !ESTIMATABLE_TYPES.has(segment.type) ||
        !estimatedStarts.has(
          `${segment.provider}:${segment.type}:${segment.start}`,
        ),
    )
    .map((segment) => ({ ...segment }));

  return {
    segments: [...canonical, ...unsafe].sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      return left.type.localeCompare(right.type);
    }),
    warnings,
  };
}
