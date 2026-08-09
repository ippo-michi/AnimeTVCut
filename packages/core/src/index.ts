export { DomainValidationError } from "./errors/validation-error.js";
export {
  subtractRemovedRanges,
  validateRemovedRanges,
} from "./cut-plan/range-subtraction.js";
export { buildTimeline, TimelineMapper } from "./timeline/timeline.js";
export type {
  AppliedCut,
  CutAlignmentPolicy,
  RemovedRange,
  SegmentKind,
  SourceRange,
  SuccessfulAppliedCut,
  TimelinePiece,
  UnappliedCut,
} from "./models/ranges.js";
