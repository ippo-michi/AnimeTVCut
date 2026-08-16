import {
  DomainValidationError,
  type AppliedCut,
  type CutAlignmentPolicy,
  type RemovedRange,
} from "@animetvcut/core";

import type { HlsVodPlaylist } from "./types.js";

const EPSILON = 1e-7;

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
    // Both preserve_content and aggressive now produce exact ranges.
    // Partial segment trimming is handled by the composer via byte ranges.
    // The policy distinction is preserved for API compatibility.
    const appliedStart = removal.start;
    const appliedEnd = removal.end;

    return {
      episodeId: removal.episodeId,
      type: removal.type,
      alignmentPolicy: policy,
      status: "applied",
      requestedStart: removal.start,
      requestedEnd: removal.end,
      appliedStart,
      appliedEnd,
      errorStart: 0,
      errorEnd: 0,
    };
  });

  return applied;
}
