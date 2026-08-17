import type { TimelinePiece } from "@animetvcut/core";

import type {
  ComposedPlaylist,
  ComposedResource,
  HlsMap,
  HlsResourceKind,
  HlsResourceMetadata,
  HlsSegment,
  HlsVodPlaylist,
} from "./types.js";

const EPSILON = 1e-6;

export interface CompositionSource {
  episodeId: string;
  playlist: HlsVodPlaylist;
}

interface SelectedSegment {
  sourceEpisodeId: string;
  segment: HlsSegment;
  discontinuityBefore: boolean;
  outputStart: number;
  /** Source time range this segment contributes to the output. */
  retainedStart: number;
  retainedEnd: number;
}

function mapKey(map: HlsMap): string {
  return `${map.absoluteUri}|${map.byteRange ?? ""}`;
}

function formatDuration(duration: number): string {
  return duration.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function composeHlsVod(
  cutId: string,
  sources: readonly CompositionSource[],
  pieces: readonly TimelinePiece[],
): ComposedPlaylist {
  const playlists = new Map(
    sources.map((source) => [source.episodeId, source.playlist]),
  );
  const selected: SelectedSegment[] = [];
  let previousPiece: TimelinePiece | undefined;
  let outputCursor = 0;

  for (const piece of pieces) {
    const playlist = playlists.get(piece.sourceEpisodeId);
    if (playlist === undefined) {
      throw new Error(`Missing HLS source for ${piece.sourceEpisodeId}`);
    }

    // Find all segments that overlap with this piece's retained range.
    // Unlike the previous strict alignment, we now accept partial segments.
    const matching = playlist.segments.filter(
      (segment) =>
        segment.start < piece.sourceEnd + EPSILON &&
        segment.end > piece.sourceStart - EPSILON,
    );

    if (matching.length === 0) {
      throw new Error(
        `No HLS segments overlap with timeline piece ${piece.id} ` +
          `[${piece.sourceStart}, ${piece.sourceEnd}]`,
      );
    }

    const sourceBoundary =
      previousPiece !== undefined &&
      (previousPiece.sourceEpisodeId !== piece.sourceEpisodeId ||
        Math.abs(previousPiece.sourceEnd - piece.sourceStart) > EPSILON);
    let emittedSegmentForPiece = false;

    for (const segment of matching) {
      // Calculate the retained portion of this segment.
      const retainedStart = Math.max(segment.start, piece.sourceStart);
      const retainedEnd = Math.min(segment.end, piece.sourceEnd);

      if (retainedEnd <= retainedStart + EPSILON) {
        continue;
      }

      selected.push({
        sourceEpisodeId: piece.sourceEpisodeId,
        segment,
        discontinuityBefore:
          segment.discontinuityBefore ||
          (sourceBoundary && !emittedSegmentForPiece),
        outputStart: outputCursor,
        retainedStart,
        retainedEnd,
      });
      emittedSegmentForPiece = true;

      outputCursor += retainedEnd - retainedStart;
    }
    previousPiece = piece;
  }

  if (selected.length === 0) {
    throw new Error("A composed HLS playlist must retain at least one segment");
  }

  const resources: ComposedResource[] = [];
  const resourceIds = new Map<string, string>();
  let nextResource = 1;
  const register = (
    sourceEpisodeId: string,
    resource: HlsResourceMetadata & { absoluteUri: string; byteRange?: string },
    kind: HlsResourceKind,
    placement?: {
      sourceStart: number;
      sourceEnd: number;
      outputStart: number;
    },
  ): string => {
    const key = `${sourceEpisodeId}|${kind}|${resource.absoluteUri}|${resource.byteRange ?? ""}|${placement?.outputStart ?? ""}`;
    const known = resourceIds.get(key);
    if (known !== undefined) {
      return known;
    }
    const id = `r${String(nextResource).padStart(6, "0")}${resource.safeExtension}`;
    nextResource += 1;
    resourceIds.set(key, id);
    resources.push({
      id,
      sourceEpisodeId,
      absoluteUri: resource.absoluteUri,
      kind,
      mediaFormat: resource.mediaFormat,
      contentType: resource.contentType,
      ...(resource.byteRange === undefined
        ? {}
        : { byteRange: resource.byteRange }),
      ...placement,
    });
    return id;
  };

  // Calculate target duration from retained segment durations.
  const maxRetainedDuration = Math.max(
    ...selected.map(({ segment, retainedStart, retainedEnd }) =>
      Math.min(segment.duration, retainedEnd - retainedStart),
    ),
  );
  const targetDuration = Math.ceil(maxRetainedDuration);
  const allIndependent = sources.every(
    (source) => source.playlist.independentSegments,
  );
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  if (allIndependent) {
    lines.push("#EXT-X-INDEPENDENT-SEGMENTS");
  }

  let activeMapKey: string | undefined;
  for (const item of selected) {
    if (item.discontinuityBefore) {
      lines.push("#EXT-X-DISCONTINUITY");
      activeMapKey = undefined;
    }
    if (item.segment.map !== undefined) {
      const currentKey = mapKey(item.segment.map);
      if (currentKey !== activeMapKey) {
        const mapId = register(item.sourceEpisodeId, item.segment.map, "map");
        const byteRange =
          item.segment.map.byteRange === undefined
            ? ""
            : `,BYTERANGE="${item.segment.map.byteRange}"`;
        lines.push(
          `#EXT-X-MAP:URI="/media/cut/${cutId}/segment/${mapId}"${byteRange}`,
        );
        activeMapKey = currentKey;
      }
    }
    const segmentId = register(item.sourceEpisodeId, item.segment, "segment", {
      sourceStart: item.retainedStart,
      sourceEnd: item.retainedEnd,
      outputStart: item.outputStart,
    });
    const retainedDuration = item.retainedEnd - item.retainedStart;
    lines.push(
      `#EXTINF:${formatDuration(retainedDuration)},${item.segment.title}`,
      `/media/cut/${cutId}/segment/${segmentId}`,
    );
  }
  lines.push("#EXT-X-ENDLIST", "");

  return {
    text: lines.join("\n"),
    resources,
    duration: selected.reduce(
      (sum, item) => sum + (item.retainedEnd - item.retainedStart),
      0,
    ),
    segmentCount: selected.length,
  };
}
