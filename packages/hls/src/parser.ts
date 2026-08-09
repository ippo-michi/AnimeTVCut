import type {
  HlsMap,
  HlsResourceMetadata,
  HlsSegment,
  HlsVodPlaylist,
} from "./types.js";

export class HlsParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HlsParseError";
  }
}

function resolveUri(uri: string, sourceUrl: string, tagName: string): string {
  if (uri.trim() === "") {
    throw new HlsParseError(`${tagName} URI must not be empty`);
  }
  try {
    return new URL(uri, sourceUrl).toString();
  } catch {
    throw new HlsParseError(`${tagName} contains an invalid URI`);
  }
}

function parseUnsignedInteger(
  value: string,
  tagName: string,
  positive: boolean,
): number {
  if (!/^\d+$/.test(value)) {
    throw new HlsParseError(`${tagName} must be a finite unsigned integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive && parsed <= 0)) {
    throw new HlsParseError(`${tagName} is outside its valid numeric range`);
  }
  return parsed;
}

function segmentMetadata(
  absoluteUri: string,
  hasMap: boolean,
): HlsResourceMetadata {
  const extension = new URL(absoluteUri).pathname
    .toLowerCase()
    .match(/\.[^./]+$/)?.[0];
  if (hasMap || extension === ".m4s" || extension === ".mp4") {
    return {
      mediaFormat: "fmp4",
      contentType: "video/mp4",
      safeExtension: extension === ".mp4" ? ".mp4" : ".m4s",
    };
  }
  if (extension === ".ts") {
    return {
      mediaFormat: "mpegts",
      contentType: "video/mp2t",
      safeExtension: ".ts",
    };
  }
  return {
    mediaFormat: "unknown",
    contentType: "application/octet-stream",
    safeExtension: ".bin",
  };
}

function parseMap(line: string, sourceUrl: string): HlsMap {
  const uriMatch = /(?:^|,)URI="([^"]+)"/.exec(line);
  if (uriMatch?.[1] === undefined) {
    throw new HlsParseError("EXT-X-MAP is missing its URI");
  }
  const byteRangeMatch = /(?:^|,)BYTERANGE="([^"]+)"/.exec(line);
  if (
    byteRangeMatch?.[1] !== undefined &&
    !/^[1-9]\d*(?:@(?:0|[1-9]\d*))?$/.test(byteRangeMatch[1])
  ) {
    throw new HlsParseError("EXT-X-MAP has an invalid BYTERANGE");
  }
  return {
    uri: uriMatch[1],
    absoluteUri: resolveUri(uriMatch[1], sourceUrl, "EXT-X-MAP"),
    mediaFormat: "fmp4",
    contentType: "video/mp4",
    safeExtension: ".mp4",
    ...(byteRangeMatch?.[1] === undefined
      ? {}
      : { byteRange: byteRangeMatch[1] }),
  };
}

export function parseHlsVodPlaylist(
  text: string,
  sourceUrl: string,
): HlsVodPlaylist {
  try {
    new URL(sourceUrl);
  } catch {
    throw new HlsParseError("Playlist source URL is invalid");
  }
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
      throw new HlsParseError(
        "Master playlists are not supported as media inputs",
      );
    }
    if (line.startsWith("#EXT-X-KEY") && !line.includes("METHOD=NONE")) {
      throw new HlsParseError("Encrypted HLS is not supported in Phase 1");
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      throw new HlsParseError(
        "Byte-range media segments are not supported in Phase 1",
      );
    }
    if (line.startsWith("#EXT-X-VERSION:")) {
      version = parseUnsignedInteger(
        line.slice("#EXT-X-VERSION:".length),
        "EXT-X-VERSION",
        true,
      );
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      declaredTargetDuration = parseUnsignedInteger(
        line.slice("#EXT-X-TARGETDURATION:".length),
        "EXT-X-TARGETDURATION",
        true,
      );
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseUnsignedInteger(
        line.slice("#EXT-X-MEDIA-SEQUENCE:".length),
        "EXT-X-MEDIA-SEQUENCE",
        false,
      );
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
      if (pendingDuration !== undefined) {
        throw new HlsParseError("EXTINF must be followed by a media URI");
      }
      const value = line.slice("#EXTINF:".length);
      const comma = value.indexOf(",");
      const durationText = comma === -1 ? value : value.slice(0, comma);
      pendingDuration = Number(durationText);
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
    const absoluteUri = resolveUri(line, sourceUrl, "Media segment");
    const metadata = segmentMetadata(absoluteUri, currentMap !== undefined);
    const segment: HlsSegment = {
      index: segments.length,
      uri: line,
      absoluteUri,
      ...metadata,
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

  if (pendingDuration !== undefined) {
    throw new HlsParseError(
      "Playlist ends with an EXTINF that has no media URI",
    );
  }
  if (!hasEndList) {
    throw new HlsParseError(
      "Input playlist is not VOD: EXT-X-ENDLIST is required",
    );
  }
  if (segments.length === 0) {
    throw new HlsParseError("Input playlist has no media segments");
  }
  if (declaredTargetDuration === undefined || declaredTargetDuration <= 0) {
    throw new HlsParseError("Input playlist has no valid EXT-X-TARGETDURATION");
  }
  const maxRoundedDuration = Math.max(
    ...segments.map((segment) => Math.round(segment.duration)),
  );
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
