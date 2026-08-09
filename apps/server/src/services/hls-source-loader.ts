import type { Readable } from "node:stream";

import type { ComposedResource, HlsVodPlaylist } from "@animetvcut/hls";

export interface HlsSourceReference {
  episodeId: string;
  playlistUrl: string;
  headers?: Readonly<Record<string, string>>;
}

export interface HlsResolvedResource {
  source: HlsSourceReference;
  resource: ComposedResource;
}

export interface MediaReadRange {
  start: number;
  end: number;
}

export interface ResolvedMediaResource {
  contentLength: number;
  contentType: string;
  responseHeaders: Readonly<Record<string, string>>;
  open: (range?: MediaReadRange) => Readable;
}

export interface HlsSourceLoader {
  loadPlaylist(source: HlsSourceReference): Promise<HlsVodPlaylist>;
  resolveResource(resource: HlsResolvedResource): Promise<ResolvedMediaResource>;
}
