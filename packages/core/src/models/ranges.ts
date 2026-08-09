export type SegmentKind =
  | "content"
  | "opening"
  | "ending"
  | "recap"
  | "preview"
  | "post_credit"
  | "unknown";

export interface SourceRange {
  sourceEpisodeId: string;
  sourceStart: number;
  sourceEnd: number;
  kind: SegmentKind;
}

export interface RemovedRange {
  episodeId: string;
  start: number;
  end: number;
  type: Exclude<SegmentKind, "content" | "post_credit" | "unknown">;
}

export interface AppliedCut {
  episodeId: string;
  type: RemovedRange["type"];
  requestedStart: number;
  requestedEnd: number;
  appliedStart: number;
  appliedEnd: number;
  errorStart: number;
  errorEnd: number;
}

export interface TimelinePiece {
  id: string;
  sourceEpisodeId: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  kind: SegmentKind;
}
