import type { HlsVodPlaylist } from "@animetvcut/hls";

import type {
  HlsResolvedResource,
  HlsSourceLoader,
  HttpMediaSource,
  LazyMediaResource,
  MediaInputSource,
} from "../hls-source-loader.js";
import type { MediaFlowClient } from "./client.js";
import { MediaFlowSourceError } from "./errors.js";

export class MediaFlowSourceLoader implements HlsSourceLoader {
  public constructor(public readonly client: MediaFlowClient) {}

  public loadPlaylist(
    source: MediaInputSource,
    signal?: AbortSignal,
  ): Promise<HlsVodPlaylist> {
    this.assertHttpMedia(source);
    return this.client.loadTranscodePlaylist(source, signal);
  }

  public createResource(resolved: HlsResolvedResource): LazyMediaResource {
    this.assertHttpMedia(resolved.source);
    return this.client.createLazyResource(resolved.resource);
  }

  private assertHttpMedia(
    source: MediaInputSource,
  ): asserts source is HttpMediaSource {
    if (source.kind !== "http_media") {
      throw new MediaFlowSourceError(
        "MediaFlow source loader only accepts HTTP media.",
      );
    }
  }
}
