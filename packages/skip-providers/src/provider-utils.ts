import type {
  SkipSegment,
  SkipSegmentType,
  UnsafeSkipReason,
} from "./models.js";

export const DURATION_ROUNDING_TOLERANCE_SECONDS = 0.5;

export function normalizedBoundedSegment(input: {
  type: SkipSegmentType;
  start: number;
  end: number;
  durationSeconds: number;
  provider: string;
  sourceType?: string;
  confidence?: number;
  submissionCount?: number;
  unsafeReason?: UnsafeSkipReason;
}): SkipSegment {
  const { start, end, durationSeconds } = input;
  let unsafeReason = input.unsafeReason;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    unsafeReason ??= "invalid_range";
  } else if (
    start < 0 ||
    start > durationSeconds + DURATION_ROUNDING_TOLERANCE_SECONDS ||
    end > durationSeconds + DURATION_ROUNDING_TOLERANCE_SECONDS
  ) {
    unsafeReason ??= "outside_duration";
  }
  const normalizedEnd =
    unsafeReason === undefined && end > durationSeconds ? durationSeconds : end;
  // After clamping, ensure start < end still holds.
  if (unsafeReason === undefined && normalizedEnd <= start) {
    unsafeReason = "invalid_range";
  }
  return {
    type: input.type,
    start,
    end: normalizedEnd,
    provider: input.provider,
    automaticRemoval: unsafeReason === undefined,
    ...(unsafeReason === undefined ? {} : { unsafeReason }),
    ...(input.sourceType === undefined ? {} : { sourceType: input.sourceType }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.submissionCount === undefined
      ? {}
      : { submissionCount: input.submissionCount }),
    ...(normalizedEnd === end ? {} : { reportedEnd: end }),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
