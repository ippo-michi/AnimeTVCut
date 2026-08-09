import type { TimelinePiece } from "@animetvcut/core";
import type { SubtitleEvent } from "./types.js";

const EPSILON = 1e-9;
export function mapSubtitleEvents(
  events: readonly SubtitleEvent[],
  pieces: readonly TimelinePiece[],
): SubtitleEvent[] {
  const mapped: SubtitleEvent[] = [];
  for (const event of events) {
    if (
      !Number.isFinite(event.start) ||
      !Number.isFinite(event.end) ||
      event.end <= event.start
    )
      continue;
    for (const piece of pieces) {
      if (piece.sourceEpisodeId !== event.sourceEpisodeId) continue;
      const start = Math.max(event.start, piece.sourceStart);
      const end = Math.min(event.end, piece.sourceEnd);
      if (end - start <= EPSILON) continue;
      mapped.push({
        ...event,
        start: piece.outputStart + start - piece.sourceStart,
        end: piece.outputStart + end - piece.sourceStart,
      });
    }
  }
  return mapped.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.sourceEpisodeOrder - right.sourceEpisodeOrder ||
      left.sourceEventOrder - right.sourceEventOrder,
  );
}
