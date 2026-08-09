export { DomainValidationError } from "./errors/validation-error.js";
export {
  subtractRemovedRanges,
  validateRemovedRanges,
} from "./cut-plan/range-subtraction.js";
export { buildTimeline, TimelineMapper } from "./timeline/timeline.js";
export type {
  AppliedCut,
  RemovedRange,
  SegmentKind,
  SourceRange,
  TimelinePiece,
} from "./models/ranges.js";
