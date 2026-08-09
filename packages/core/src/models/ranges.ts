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

export type CutAlignmentPolicy = "preserve_content" | "aggressive";

interface AppliedCutBase {
  episodeId: string;
  type: RemovedRange["type"];
  alignmentPolicy: CutAlignmentPolicy;
  requestedStart: number;
  requestedEnd: number;
}

export interface SuccessfulAppliedCut extends AppliedCutBase {
  status: "applied";
  appliedStart: number;
  appliedEnd: number;
  errorStart: number;
  errorEnd: number;
}

export interface UnappliedCut extends AppliedCutBase {
  status: "no_safe_segments";
  reason: "no_complete_segments";
  appliedStart: null;
  appliedEnd: null;
  errorStart: null;
  errorEnd: null;
}

export type AppliedCut = SuccessfulAppliedCut | UnappliedCut;

export interface TimelinePiece {
  id: string;
  sourceEpisodeId: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  kind: SegmentKind;
}
