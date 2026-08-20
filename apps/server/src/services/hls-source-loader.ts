import type { Readable } from "node:stream";

import type { ComposedResource, HlsVodPlaylist } from "@animetvcut/hls";

export interface FixtureHlsSource {
  kind: "fixture_hls";
  episodeId: string;
  playlistUrl: string;
}

export interface HttpMediaSource {
  kind: "http_media";
  episodeId: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
  sourceMetadata?: {
    filename?: string;
    videoSize?: number;
    upstreamRank?: number;
    bingeGroup?: string;
  };
}

export type MediaInputSource = FixtureHlsSource | HttpMediaSource;

export interface HlsResolvedResource {
  source: MediaInputSource;
  resource: ComposedResource;
}

export interface MediaReadRange {
  start: number;
  end?: number;
}

export interface OpenedMediaResource {
  statusCode: 200 | 206;
  contentType: string;
  contentLength?: number;
  responseHeaders: Readonly<Record<string, string>>;
  stream: Readable;
}

export interface LazyMediaResource {
  contentType: string;
  open: (
    range?: MediaReadRange,
    signal?: AbortSignal,
  ) => Promise<OpenedMediaResource>;
}

export interface HlsSourceLoader {
  loadPlaylist(
    source: MediaInputSource,
    signal?: AbortSignal,
  ): Promise<HlsVodPlaylist>;
  createResource(resource: HlsResolvedResource): LazyMediaResource;
}

export class MediaRangeNotSatisfiableError extends Error {
  public constructor(public readonly contentLength?: number) {
    super("Requested media byte range is not satisfiable");
    this.name = "MediaRangeNotSatisfiableError";
  }
}
