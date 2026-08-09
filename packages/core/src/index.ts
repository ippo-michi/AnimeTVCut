export { DomainValidationError } from "./errors/validation-error.js";
export {
  subtractRemovedRanges,
  validateRemovedRanges,
} from "./cut-plan/range-subtraction.js";
export { buildTimeline, TimelineMapper } from "./timeline/timeline.js";
export { mapOutputSkipSegments } from "./timeline/output-skip.js";
export type {
  OutputSkipDiagnostic,
  OutputSkipMappingResult,
  OutputSkipSegment,
  OutputSkipSegmentReason,
  OutputSkipSegmentType,
  SafeSourceSkipSegment,
} from "./timeline/output-skip.js";
export { parseRuntimeSeconds } from "./grouping/runtime.js";
export {
  DEFAULT_TV_CUT_GROUPING_CONFIG,
  estimatedCutDuration,
  groupTvCutEpisodes,
} from "./grouping/tv-cut.js";
export type {
  GroupableEpisode,
  TvCutGroup,
  TvCutGroupingConfig,
  TvCutGroupingResult,
} from "./grouping/tv-cut.js";
export {
  DEFAULT_LONG_CUT_PLANNING_CONFIG,
  planLongCuts,
} from "./grouping/long-cuts.js";
export type {
  LongCutEpisode,
  LongCutIneligibilityReason,
  LongCutPlan,
  LongCutPlanningConfig,
  LongFormCutMode,
  PlannedLongSeason,
  PlannedLongSeries,
  VirtualChapter,
} from "./grouping/long-cuts.js";
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
