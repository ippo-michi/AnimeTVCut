import {
  DomainValidationError,
  type AppliedCut,
  type CutAlignmentPolicy,
  type RemovedRange,
  type SuccessfulAppliedCut,
} from "@animetvcut/core";

import type { HlsVodPlaylist } from "./types.js";

const EPSILON = 1e-7;

function floorBoundary(boundaries: readonly number[], value: number): number {
  const result = [...boundaries]
    .reverse()
    .find((boundary) => boundary <= value + EPSILON);
  if (result === undefined) {
    throw new DomainValidationError(
      "Could not find a segment boundary before cut start",
    );
  }
  return result;
}

function ceilBoundary(boundaries: readonly number[], value: number): number {
  const result = boundaries.find((boundary) => boundary >= value - EPSILON);
  if (result === undefined) {
    throw new DomainValidationError(
      "Could not find a segment boundary after cut end",
    );
  }
  return result;
}

/**
 * Remove only segments fully contained within the removal range.
 * This is the "preserve_content" strategy: it minimizes over-deletion
 * of neighboring content by never consuming segments that only partially
 * overlap the requested removal range.
 *
 * Trade-off: if the removal range does not align with segment boundaries,
 * partial content at the boundaries may remain in the output.
 */
function removeFullyContainedSegments(
  playlist: HlsVodPlaylist,
  start: number,
  end: number,
): { appliedStart: number | null; appliedEnd: number | null } {
  const segments = playlist.segments;
  let appliedStart: number | null = null;
  let appliedEnd: number | null = null;

  for (const segment of segments) {
    // Only remove segments fully contained within [start, end]
    if (segment.start >= start - EPSILON && segment.end <= end + EPSILON) {
      if (appliedStart === null || segment.start < appliedStart) {
        appliedStart = segment.start;
      }
      if (appliedEnd === null || segment.end > appliedEnd) {
        appliedEnd = segment.end;
      }
    }
  }

  return { appliedStart, appliedEnd };
}

/**
 * Expand the removal to cover all segments that overlap the requested range.
 * This is the "aggressive" strategy: it guarantees no media from [start, end]
 * remains in the output, but may remove additional content beyond the
 * requested range when segments do not align with the boundaries.
 */
function expandToOverlappingSegments(
  boundaries: readonly number[],
  start: number,
  end: number,
): { appliedStart: number; appliedEnd: number } {
  const appliedStart = floorBoundary(boundaries, start);
  const appliedEnd = ceilBoundary(boundaries, end);
  return { appliedStart, appliedEnd };
}

export function alignRemovedRanges(
  playlist: HlsVodPlaylist,
  removals: readonly RemovedRange[],
  options: {
    policy?: CutAlignmentPolicy;
    strict?: boolean;
  } = {},
): AppliedCut[] {
  const policy = options.policy ?? "preserve_content";
  const sorted = [...removals].sort((left, right) => left.start - right.start);
  const boundaries = [0, ...playlist.segments.map((segment) => segment.end)];

  for (const [index, removal] of sorted.entries()) {
    if (
      !Number.isFinite(removal.start) ||
      !Number.isFinite(removal.end) ||
      removal.start < 0 ||
      removal.end > playlist.duration + EPSILON ||
      removal.start >= removal.end
    ) {
      throw new DomainValidationError(
        "Requested removal is outside the source duration",
      );
    }
    const previous = sorted[index - 1];
    if (previous !== undefined && removal.start < previous.end) {
      throw new DomainValidationError("Requested removals must not overlap");
    }
  }

  const applied = sorted.map((removal): AppliedCut => {
    let appliedStart: number | null;
    let appliedEnd: number | null;

    if (policy === "preserve_content") {
      // Only remove segments fully contained within the removal range.
      // Never consumes segments that only partially overlap.
      const contained = removeFullyContainedSegments(
        playlist,
        removal.start,
        removal.end,
      );
      appliedStart = contained.appliedStart;
      appliedEnd = contained.appliedEnd;
    } else {
      // Aggressive: expand to cover all overlapping segments.
      // Guarantees complete removal but may over-delete.
      const expanded = expandToOverlappingSegments(
        boundaries,
        removal.start,
        removal.end,
      );
      appliedStart = expanded.appliedStart;
      appliedEnd = expanded.appliedEnd;
    }

    if (
      appliedStart === null ||
      appliedEnd === null ||
      appliedStart >= appliedEnd - EPSILON
    ) {
      if (options.strict === true) {
        throw new DomainValidationError(
          `No complete HLS segment can be safely removed for ${removal.episodeId} ${removal.start}-${removal.end}`,
        );
      }
      return {
        episodeId: removal.episodeId,
        type: removal.type,
        alignmentPolicy: policy,
        status: "no_safe_segments",
        reason: "no_complete_segments",
        requestedStart: removal.start,
        requestedEnd: removal.end,
        appliedStart: null,
        appliedEnd: null,
        errorStart: null,
        errorEnd: null,
      };
    }

    return {
      episodeId: removal.episodeId,
      type: removal.type,
      alignmentPolicy: policy,
      status: "applied",
      requestedStart: removal.start,
      requestedEnd: removal.end,
      appliedStart,
      appliedEnd,
      errorStart: appliedStart - removal.start,
      errorEnd: appliedEnd - removal.end,
    };
  });

  const successful = applied.filter(
    (cut): cut is SuccessfulAppliedCut => cut.status === "applied",
  );
  for (let index = 1; index < successful.length; index += 1) {
    const previous = successful[index - 1];
    const current = successful[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.appliedStart < previous.appliedEnd - EPSILON
    ) {
      throw new DomainValidationError(
        "Segment alignment made requested removals overlap",
      );
    }
  }

  return applied;
}
