import type {
  AutomaticCutPlan,
  AutomaticCutPolicy,
  AutomaticRemoval,
  EpisodeSkipResolution,
  PlannedSkipSegment,
  SkipPolicyDecision,
} from "./models.js";

export const DEFAULT_AUTOMATIC_CUT_POLICY: AutomaticCutPolicy = {
  openings: "first_only",
  endings: "last_only",
  removeRecaps: true,
  removePreviews: true,
};

function decisionFor(
  segment: EpisodeSkipResolution["segments"][number],
  episodeIndex: number,
  lastEpisodeIndex: number,
  policy: AutomaticCutPolicy,
): SkipPolicyDecision {
  if (!segment.automaticRemoval || segment.end === null)
    return "unsafe_ignored";
  if (segment.type === "opening") {
    if (policy.openings === "keep_all") return "keep_by_policy";
    if (policy.openings === "first_only" && episodeIndex === 0) {
      return "keep_first_opening";
    }
    return "remove";
  }
  if (segment.type === "ending") {
    if (policy.endings === "keep_all") return "keep_by_policy";
    if (policy.endings === "last_only" && episodeIndex === lastEpisodeIndex) {
      return "keep_last_ending";
    }
    return "remove";
  }
  if (segment.type === "recap") {
    return policy.removeRecaps ? "remove" : "keep_by_policy";
  }
  return policy.removePreviews ? "remove" : "keep_by_policy";
}

export function buildAutomaticCutPlan(
  episodes: readonly EpisodeSkipResolution[],
  policy: AutomaticCutPolicy = DEFAULT_AUTOMATIC_CUT_POLICY,
): AutomaticCutPlan {
  const removals: AutomaticRemoval[] = [];
  const plannedEpisodes = episodes.map((episode, episodeIndex) => {
    const segments: PlannedSkipSegment[] = episode.segments.map((segment) => {
      const decision = decisionFor(
        segment,
        episodeIndex,
        episodes.length - 1,
        policy,
      );
      if (decision === "remove" && segment.end !== null) {
        removals.push({
          episodeId: episode.episodeId,
          start: segment.start,
          end: segment.end,
          type: segment.type,
        });
      }
      return { ...segment, decision };
    });
    return { episodeId: episode.episodeId, segments };
  });
  return {
    policy,
    episodes: plannedEpisodes,
    automaticRemovals: removals,
    warnings: episodes.flatMap((episode) => [...episode.warnings]),
  };
}

export function mergeRemovalRanges<T extends AutomaticRemoval>(
  ranges: readonly T[],
): AutomaticRemoval[] {
  const sorted = [...ranges].sort((left, right) => {
    const episode = left.episodeId.localeCompare(right.episodeId);
    return episode !== 0 ? episode : left.start - right.start;
  });
  const merged: AutomaticRemoval[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.episodeId === range.episodeId &&
      range.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}
