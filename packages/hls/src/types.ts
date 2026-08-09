export interface HlsMap {
  uri: string;
  absoluteUri: string;
  byteRange?: string;
}

export interface HlsSegment {
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
  kind: "segment" | "map";
  contentType: string;
}

export interface ComposedPlaylist {
  text: string;
  resources: ComposedResource[];
  duration: number;
  segmentCount: number;
}
