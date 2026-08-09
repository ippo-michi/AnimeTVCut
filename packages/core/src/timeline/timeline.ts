import { DomainValidationError } from "../errors/validation-error.js";
import type { SourceRange, TimelinePiece } from "../models/ranges.js";

const EPSILON = 1e-9;

export function buildTimeline(ranges: readonly SourceRange[]): TimelinePiece[] {
  const pieces: TimelinePiece[] = [];
  let outputCursor = 0;

  for (const [index, range] of ranges.entries()) {
    if (range.sourceStart >= range.sourceEnd) {
      throw new DomainValidationError("Timeline source range start must be before end");
    }

    const duration = range.sourceEnd - range.sourceStart;
    const piece: TimelinePiece = {
      id: `piece-${index + 1}`,
      sourceEpisodeId: range.sourceEpisodeId,
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      outputStart: outputCursor,
      outputEnd: outputCursor + duration,
      kind: range.kind,
    };
    pieces.push(piece);
    outputCursor = piece.outputEnd;
  }

  return pieces;
}

export class TimelineMapper {
  public readonly duration: number;

  public constructor(public readonly pieces: readonly TimelinePiece[]) {
    let expectedStart = 0;
    for (const piece of pieces) {
      if (Math.abs(piece.outputStart - expectedStart) > EPSILON) {
        throw new DomainValidationError("Timeline pieces must be contiguous and ordered");
      }
      if (piece.sourceStart >= piece.sourceEnd || piece.outputStart >= piece.outputEnd) {
        throw new DomainValidationError("Timeline pieces must have positive duration");
      }
      const sourceDuration = piece.sourceEnd - piece.sourceStart;
      const outputDuration = piece.outputEnd - piece.outputStart;
      if (Math.abs(sourceDuration - outputDuration) > EPSILON) {
        throw new DomainValidationError("Timeline source and output durations must match");
      }
      expectedStart = piece.outputEnd;
    }
    this.duration = expectedStart;
  }

  public sourceToOutput(episodeId: string, sourceTime: number): number | null {
    if (!Number.isFinite(sourceTime)) {
      return null;
    }

    const piece = this.pieces.find(
      (candidate) =>
        candidate.sourceEpisodeId === episodeId &&
        sourceTime >= candidate.sourceStart &&
        sourceTime < candidate.sourceEnd,
    );
    if (piece !== undefined) {
      return piece.outputStart + (sourceTime - piece.sourceStart);
    }

    const finalPiece = this.pieces.at(-1);
    if (
      finalPiece !== undefined &&
      finalPiece.sourceEpisodeId === episodeId &&
      Math.abs(sourceTime - finalPiece.sourceEnd) <= EPSILON
    ) {
      return finalPiece.outputEnd;
    }
    return null;
  }

  public outputToSource(
    outputTime: number,
  ): { episodeId: string; sourceTime: number } | null {
    if (!Number.isFinite(outputTime) || outputTime < 0) {
      return null;
    }

    const piece = this.pieces.find(
      (candidate) => outputTime >= candidate.outputStart && outputTime < candidate.outputEnd,
    );
    if (piece !== undefined) {
      return {
        episodeId: piece.sourceEpisodeId,
        sourceTime: piece.sourceStart + (outputTime - piece.outputStart),
      };
    }

    const finalPiece = this.pieces.at(-1);
    if (finalPiece !== undefined && Math.abs(outputTime - this.duration) <= EPSILON) {
      return {
        episodeId: finalPiece.sourceEpisodeId,
        sourceTime: finalPiece.sourceEnd,
      };
    }
    return null;
  }
}
