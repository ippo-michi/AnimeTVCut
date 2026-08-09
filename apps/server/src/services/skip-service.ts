import {
  deriveSkipLookupIdentity,
  type EpisodeSkipResolution,
  type SkipProviderHealth,
  type SkipSegmentResolver,
} from "@animetvcut/skip-providers";

import type { UpstreamEpisodeReference } from "./stremio-upstream/types.js";

export interface EpisodeSkipLookupRequest {
  reference: UpstreamEpisodeReference;
  durationSeconds: number;
}

export class SkipService {
  public constructor(public readonly resolver: SkipSegmentResolver) {}

  public resolve(
    requests: readonly EpisodeSkipLookupRequest[],
    signal?: AbortSignal,
  ): Promise<EpisodeSkipResolution[]> {
    return this.resolver.resolveEpisodes(
      requests.map(({ reference, durationSeconds }) => ({
        episodeId: reference.episodeId,
        identity: deriveSkipLookupIdentity(
          reference.videoId,
          reference.skipIdentity,
        ),
        durationSeconds,
      })),
      signal,
    );
  }

  public health(): Promise<SkipProviderHealth[]> {
    return this.resolver.health();
  }
}

export function sanitizeSkipResolution(resolution: EpisodeSkipResolution) {
  return {
    episodeId: resolution.episodeId,
    identity: {
      imdbAvailable: resolution.identity.imdb !== undefined,
      malAvailable: resolution.identity.mal !== undefined,
    },
    durationSeconds: resolution.durationSeconds,
    providers: resolution.providers.map(({ provider, status }) => ({
      provider,
      status,
    })),
    segments: resolution.segments,
    warnings: resolution.warnings,
  };
}
