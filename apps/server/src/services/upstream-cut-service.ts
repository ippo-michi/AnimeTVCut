import type { CutAlignmentPolicy, RemovedRange } from "@animetvcut/core";

import type { CutService, DevCutResponse } from "./cut-service.js";
import { StremioUpstreamNotConfiguredError } from "./stremio-upstream/errors.js";
import { sanitizeCandidateSelection } from "./stremio-upstream/resolver.js";
import type {
  EpisodeSourceResolver,
  SanitizedCandidateSelection,
  UpstreamEpisodeReference,
} from "./stremio-upstream/types.js";

export interface UpstreamCutRequest {
  episodes: readonly UpstreamEpisodeReference[];
  remove: RemovedRange[];
  allowMixedSources?: boolean;
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
}

export interface UpstreamCutResponse extends DevCutResponse {
  selection: SanitizedCandidateSelection;
}

export class UpstreamCutService {
  public constructor(
    private readonly resolver: EpisodeSourceResolver | undefined,
    private readonly cutService: CutService,
  ) {}

  public async resolveEpisodes(
    episodes: readonly UpstreamEpisodeReference[],
    allowMixedSources = false,
  ): Promise<SanitizedCandidateSelection> {
    if (this.resolver === undefined)
      throw new StremioUpstreamNotConfiguredError();
    const selection = await this.resolver.resolve(episodes, {
      allowMixedSources,
    });
    return sanitizeCandidateSelection(selection);
  }

  public async createCutFromEpisodes(
    request: UpstreamCutRequest,
  ): Promise<UpstreamCutResponse> {
    if (this.resolver === undefined)
      throw new StremioUpstreamNotConfiguredError();
    const selection = await this.resolver.resolve(request.episodes, {
      allowMixedSources: request.allowMixedSources ?? false,
    });
    const cut = await this.cutService.createCut({
      sources: selection.episodes.map((episode) => episode.mediaSource),
      remove: request.remove,
      ...(request.alignmentPolicy === undefined
        ? {}
        : { alignmentPolicy: request.alignmentPolicy }),
      ...(request.strictAlignment === undefined
        ? {}
        : { strictAlignment: request.strictAlignment }),
    });
    return { ...cut, selection: sanitizeCandidateSelection(selection) };
  }
}
