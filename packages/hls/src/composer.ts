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
  const playlists = new Map(sources.map((source) => [source.episodeId, source.playlist]));
  const selected: SelectedSegment[] = [];
  let previousPiece: TimelinePiece | undefined;

  for (const piece of pieces) {
    const playlist = playlists.get(piece.sourceEpisodeId);
    if (playlist === undefined) {
      throw new Error(`Missing HLS source for ${piece.sourceEpisodeId}`);
    }
    const matching = playlist.segments.filter(
      (segment) =>
        segment.start >= piece.sourceStart - EPSILON &&
        segment.end <= piece.sourceEnd + EPSILON,
    );
    const matchedDuration = matching.reduce((sum, segment) => sum + segment.duration, 0);
    if (Math.abs(matchedDuration - (piece.sourceEnd - piece.sourceStart)) > EPSILON) {
      throw new Error(`Timeline piece ${piece.id} is not aligned to complete HLS segments`);
    }

    for (const [index, segment] of matching.entries()) {
      const sourceBoundary =
        index === 0 &&
        previousPiece !== undefined &&
        (previousPiece.sourceEpisodeId !== piece.sourceEpisodeId ||
          Math.abs(previousPiece.sourceEnd - piece.sourceStart) > EPSILON);
      selected.push({
        sourceEpisodeId: piece.sourceEpisodeId,
        segment,
        discontinuityBefore: segment.discontinuityBefore || sourceBoundary,
      });
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
  ): string => {
    const key = `${sourceEpisodeId}|${kind}|${resource.absoluteUri}|${resource.byteRange ?? ""}`;
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
      ...(resource.byteRange === undefined ? {} : { byteRange: resource.byteRange }),
    });
    return id;
  };

  const maxSegmentDuration = Math.max(...selected.map(({ segment }) => segment.duration));
  const targetDuration = Math.ceil(maxSegmentDuration);
  const allIndependent = sources.every((source) => source.playlist.independentSegments);
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
            : `,BYTERANGE=\"${item.segment.map.byteRange}\"`;
        lines.push(
          `#EXT-X-MAP:URI=\"/media/cut/${cutId}/segment/${mapId}\"${byteRange}`,
        );
        activeMapKey = currentKey;
      }
    }
    const segmentId = register(item.sourceEpisodeId, item.segment, "segment");
    lines.push(
      `#EXTINF:${formatDuration(item.segment.duration)},${item.segment.title}`,
      `/media/cut/${cutId}/segment/${segmentId}`,
    );
  }
  lines.push("#EXT-X-ENDLIST", "");

  return {
    text: lines.join("\n"),
    resources,
    duration: selected.reduce((sum, item) => sum + item.segment.duration, 0),
    segmentCount: selected.length,
  };
}
