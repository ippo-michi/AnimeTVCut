import { DomainValidationError } from "../errors/validation-error.js";
import type { RemovedRange, SourceRange } from "../models/ranges.js";

const EPSILON = 1e-9;

export function validateRemovedRanges(
  source: SourceRange,
  removedRanges: readonly RemovedRange[],
): RemovedRange[] {
  const sorted = [...removedRanges].sort(
    (left, right) => left.start - right.start,
  );

  for (const range of sorted) {
    if (range.episodeId !== source.sourceEpisodeId) {
      throw new DomainValidationError(
        `Removed range episode ${range.episodeId} does not match ${source.sourceEpisodeId}`,
      );
    }
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
      throw new DomainValidationError(
        "Range coordinates must be finite numbers",
      );
    }
    if (range.start >= range.end) {
      throw new DomainValidationError("Removed range start must be before end");
    }
    if (
      range.start < source.sourceStart - EPSILON ||
      range.end > source.sourceEnd + EPSILON
    ) {
      throw new DomainValidationError(
        "Removed range lies outside the source range",
      );
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.start < previous.end
    ) {
      throw new DomainValidationError("Removed ranges must not overlap");
    }
  }

  return sorted;
}

export function subtractRemovedRanges(
  source: SourceRange,
  removedRanges: readonly RemovedRange[],
): SourceRange[] {
  if (source.sourceStart >= source.sourceEnd) {
    throw new DomainValidationError("Source range start must be before end");
  }

  const sorted = validateRemovedRanges(source, removedRanges);
  const retained: SourceRange[] = [];
  let cursor = source.sourceStart;

  for (const removed of sorted) {
    if (removed.start > cursor + EPSILON) {
      retained.push({
        sourceEpisodeId: source.sourceEpisodeId,
        sourceStart: cursor,
        sourceEnd: removed.start,
        kind: source.kind,
      });
    }
    cursor = removed.end;
  }

  if (cursor < source.sourceEnd - EPSILON) {
    retained.push({
      sourceEpisodeId: source.sourceEpisodeId,
      sourceStart: cursor,
      sourceEnd: source.sourceEnd,
      kind: source.kind,
    });
  }

  return retained;
}
