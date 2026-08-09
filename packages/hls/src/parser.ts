import type { HlsMap, HlsSegment, HlsVodPlaylist } from "./types.js";

export class HlsParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HlsParseError";
  }
}

function parseMap(line: string, sourceUrl: string): HlsMap {
  const uriMatch = /(?:^|,)URI="([^"]+)"/.exec(line);
  if (uriMatch?.[1] === undefined) {
    throw new HlsParseError("EXT-X-MAP is missing its URI");
  }
  const byteRangeMatch = /(?:^|,)BYTERANGE="([^"]+)"/.exec(line);
  return {
    uri: uriMatch[1],
    absoluteUri: new URL(uriMatch[1], sourceUrl).toString(),
    ...(byteRangeMatch?.[1] === undefined ? {} : { byteRange: byteRangeMatch[1] }),
  };
}

export function parseHlsVodPlaylist(text: string, sourceUrl: string): HlsVodPlaylist {
  const lines = text
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines[0] !== "#EXTM3U") {
    throw new HlsParseError("Playlist must begin with EXTM3U");
  }

  let version: number | undefined;
  let declaredTargetDuration: number | undefined;
  let mediaSequence = 0;
  let hasEndList = false;
  let independentSegments = false;
  let pendingDuration: number | undefined;
  let pendingTitle = "";
  let pendingDiscontinuity = false;
  let currentMap: HlsMap | undefined;
  let cursor = 0;
  const segments: HlsSegment[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      throw new HlsParseError("Master playlists are not supported as media inputs");
    }
    if (line.startsWith("#EXT-X-KEY") && !line.includes("METHOD=NONE")) {
      throw new HlsParseError("Encrypted HLS is not supported in Phase 1");
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      throw new HlsParseError("Byte-range media segments are not supported in Phase 1");
    }
    if (line.startsWith("#EXT-X-VERSION:")) {
      version = Number.parseInt(line.slice("#EXT-X-VERSION:".length), 10);
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      declaredTargetDuration = Number.parseInt(
        line.slice("#EXT-X-TARGETDURATION:".length),
        10,
      );
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
      continue;
    }
    if (line === "#EXT-X-INDEPENDENT-SEGMENTS") {
      independentSegments = true;
      continue;
    }
    if (line === "#EXT-X-DISCONTINUITY") {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      currentMap = parseMap(line.slice("#EXT-X-MAP:".length), sourceUrl);
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length);
      const comma = value.indexOf(",");
      const durationText = comma === -1 ? value : value.slice(0, comma);
      pendingDuration = Number.parseFloat(durationText);
      pendingTitle = comma === -1 ? "" : value.slice(comma + 1);
      if (!Number.isFinite(pendingDuration) || pendingDuration <= 0) {
        throw new HlsParseError("EXTINF duration must be positive and finite");
      }
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      hasEndList = true;
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    if (pendingDuration === undefined) {
      throw new HlsParseError(`Media URI has no EXTINF: ${line}`);
    }
    const segment: HlsSegment = {
      index: segments.length,
      uri: line,
      absoluteUri: new URL(line, sourceUrl).toString(),
      duration: pendingDuration,
      title: pendingTitle,
      start: cursor,
      end: cursor + pendingDuration,
      discontinuityBefore: pendingDiscontinuity,
      ...(currentMap === undefined ? {} : { map: currentMap }),
    };
    segments.push(segment);
    cursor = segment.end;
    pendingDuration = undefined;
    pendingTitle = "";
    pendingDiscontinuity = false;
  }

  if (!hasEndList) {
    throw new HlsParseError("Input playlist is not VOD: EXT-X-ENDLIST is required");
  }
  if (segments.length === 0) {
    throw new HlsParseError("Input playlist has no media segments");
  }
  if (declaredTargetDuration === undefined || declaredTargetDuration <= 0) {
    throw new HlsParseError("Input playlist has no valid EXT-X-TARGETDURATION");
  }
  const maxRoundedDuration = Math.max(...segments.map((segment) => Math.round(segment.duration)));
  if (declaredTargetDuration < maxRoundedDuration) {
    throw new HlsParseError("Input EXT-X-TARGETDURATION is too small");
  }

  return {
    sourceUrl,
    ...(version === undefined ? {} : { version }),
    targetDuration: declaredTargetDuration,
    mediaSequence,
    duration: cursor,
    segments,
    independentSegments,
  };
}
