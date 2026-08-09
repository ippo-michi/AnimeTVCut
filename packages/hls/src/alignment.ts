import {
  DomainValidationError,
  type AppliedCut,
  type RemovedRange,
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
): AppliedCut[] {
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
    const appliedStart = floorBoundary(boundaries, removal.start);
    const appliedEnd = ceilBoundary(boundaries, removal.end);
    return {
      episodeId: removal.episodeId,
      type: removal.type,
      requestedStart: removal.start,
      requestedEnd: removal.end,
      appliedStart,
      appliedEnd,
      errorStart: appliedStart - removal.start,
      errorEnd: appliedEnd - removal.end,
    };
  });

  for (let index = 1; index < applied.length; index += 1) {
    const previous = applied[index - 1];
    const current = applied[index];
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
