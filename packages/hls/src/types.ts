export type HlsMediaFormat = "mpegts" | "fmp4" | "unknown";
export type HlsResourceKind = "segment" | "map";
export type SafeResourceExtension = ".ts" | ".m4s" | ".mp4" | ".bin";

export interface HlsResourceMetadata {
  mediaFormat: HlsMediaFormat;
  contentType: string;
  safeExtension: SafeResourceExtension;
}

export interface HlsMap extends HlsResourceMetadata {
  uri: string;
  absoluteUri: string;
  byteRange?: string;
}

export interface HlsSegment extends HlsResourceMetadata {
  index: number;
  uri: string;
  absoluteUri: string;
  duration: number;
  title: string;
  start: number;
  end: number;
  discontinuityBefore: boolean;
  map?: HlsMap;
}

export interface HlsVodPlaylist {
  sourceUrl: string;
  version?: number;
  targetDuration: number;
  mediaSequence: number;
  duration: number;
  segments: HlsSegment[];
  independentSegments: boolean;
}

export interface ComposedResource {
  id: string;
  sourceEpisodeId: string;
  absoluteUri: string;
  kind: HlsResourceKind;
  mediaFormat: HlsMediaFormat;
  contentType: string;
  byteRange?: string;
}

export interface ComposedPlaylist {
  text: string;
  resources: ComposedResource[];
  duration: number;
  segmentCount: number;
}
