import type {
  ReconciledSkipSegment,
  SkipProviderResult,
  SkipSegment,
  SkipSegmentProvider,
} from "./models.js";

const STRONG_OVERLAP_RATIO = 0.8;
const CORROBORATED_OPEN_START_TOLERANCE_SECONDS = 15;

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

export function reconcileSkipSegments(
  results: readonly SkipProviderResult[],
  providers: readonly SkipSegmentProvider[],
): { segments: ReconciledSkipSegment[]; warnings: string[] } {
  const priorities = new Map(
    providers.map((provider) => [provider.name, provider.priority]),
  );
  const reports = results.flatMap((result) => [...result.segments]);
  const boundaryWarnings: string[] = [];
  const safe = reports
    .filter(
      (segment): segment is SkipSegment & { end: number } =>
        segment.automaticRemoval && segment.end !== null,
    )
    .map((segment) => {
      const corroboratingStart = reports
        .filter(
          (candidate) =>
            candidate.type === "ending" &&
            candidate.type === segment.type &&
            candidate.provider !== segment.provider &&
            candidate.end === null &&
            candidate.unsafeReason === "open_ended" &&
            candidate.start < segment.start &&
            segment.start - candidate.start <=
              CORROBORATED_OPEN_START_TOLERANCE_SECONDS,
        )
        .sort((left, right) => right.start - left.start)[0];
      if (corroboratingStart === undefined) return segment;
      boundaryWarnings.push(
        `Used a corroborating ${corroboratingStart.provider} ending start with the bounded ${segment.provider} ending range.`,
      );
      return { ...segment, start: corroboratingStart.start };
    })
    .sort((left, right) => {
      const type = left.type.localeCompare(right.type);
      if (type !== 0) return type;
      const priority =
        (priorities.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
        (priorities.get(right.provider) ?? Number.MAX_SAFE_INTEGER);
      if (priority !== 0) return priority;
      if (left.start !== right.start) return left.start - right.start;
      if (left.end !== right.end) return left.end - right.end;
      return left.provider.localeCompare(right.provider);
    });
  const canonical: ReconciledSkipSegment[] = [];
  const warnings: string[] = [...new Set(boundaryWarnings)];
  for (const segment of safe) {
    const matchingIndex = canonical.findIndex((existing) =>
      stronglyOverlaps(existing, segment),
    );
    if (matchingIndex === -1) {
      canonical.push({ ...segment });
      continue;
    }
    const existing = canonical[matchingIndex]!;
    canonical[matchingIndex] = {
      ...existing,
      alternatives: [
        ...(existing.alternatives ?? []),
        { provider: segment.provider, start: segment.start, end: segment.end },
      ],
    };
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

  const unsafe = reports
    .filter((segment) => !segment.automaticRemoval || segment.end === null)
    .map((segment) => ({ ...segment }));
  return {
    segments: [...canonical, ...unsafe].sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      return left.type.localeCompare(right.type);
    }),
    warnings,
  };
}
