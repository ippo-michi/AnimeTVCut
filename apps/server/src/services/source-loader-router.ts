import type {
  HlsResolvedResource,
  HlsSourceLoader,
  LazyMediaResource,
  MediaInputSource,
} from "./hls-source-loader.js";
import type { HlsVodPlaylist } from "@animetvcut/hls";
import { MediaFlowNotConfiguredError } from "./mediaflow/errors.js";

export class SourceLoaderRouter implements HlsSourceLoader {
  public constructor(
    private readonly fixtureLoader: HlsSourceLoader,
    private readonly mediaFlowLoader?: HlsSourceLoader,
  ) {}

  public loadPlaylist(
    source: MediaInputSource,
    signal?: AbortSignal,
  ): Promise<HlsVodPlaylist> {
    return this.loaderFor(source).loadPlaylist(source, signal);
  }

  public createResource(resolved: HlsResolvedResource): LazyMediaResource {
    return this.loaderFor(resolved.source).createResource(resolved);
  }

  private loaderFor(source: MediaInputSource): HlsSourceLoader {
    if (source.kind === "fixture_hls") {
      return this.fixtureLoader;
    }
    if (this.mediaFlowLoader === undefined) {
      throw new MediaFlowNotConfiguredError();
    }
    return this.mediaFlowLoader;
  }
}
