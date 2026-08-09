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
  const result = [...boundaries].reverse().find((boundary) => boundary <= value + EPSILON);
  if (result === undefined) {
    throw new DomainValidationError("Could not find a segment boundary before cut start");
  }
  return result;
}

function ceilBoundary(boundaries: readonly number[], value: number): number {
  const result = boundaries.find((boundary) => boundary >= value - EPSILON);
  if (result === undefined) {
    throw new DomainValidationError("Could not find a segment boundary after cut end");
  }
  return result;
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
      throw new DomainValidationError("Requested removal is outside the source duration");
    }
    const previous = sorted[index - 1];
    if (previous !== undefined && removal.start < previous.end) {
      throw new DomainValidationError("Requested removals must not overlap");
    }
  }

  const applied = sorted.map((removal): AppliedCut => {
    const appliedStart =
      policy === "preserve_content"
        ? ceilBoundary(boundaries, removal.start)
        : floorBoundary(boundaries, removal.start);
    const appliedEnd =
      policy === "preserve_content"
        ? floorBoundary(boundaries, removal.end)
        : ceilBoundary(boundaries, removal.end);

    if (appliedStart >= appliedEnd - EPSILON) {
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
      throw new DomainValidationError("Segment alignment made requested removals overlap");
    }
  }

  return applied;
}
