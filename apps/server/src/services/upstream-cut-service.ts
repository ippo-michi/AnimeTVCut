import type { CutAlignmentPolicy, RemovedRange } from "@animetvcut/core";
import {
  buildAutomaticCutPlan,
  DEFAULT_AUTOMATIC_CUT_POLICY,
  mergeRemovalRanges,
  type AutomaticCutPolicy,
} from "@animetvcut/skip-providers";

import type {
  CutService,
  DevCutResponse,
  PreparedInputSource,
} from "./cut-service.js";
import { sanitizeSkipResolution, type SkipService } from "./skip-service.js";
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

export interface AutomaticUpstreamCutRequest {
  episodes: readonly UpstreamEpisodeReference[];
  remove?: RemovedRange[];
  cutPolicy?: Partial<AutomaticCutPolicy>;
  allowMixedSources?: boolean;
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
}

export class UpstreamCutService {
  public constructor(
    private readonly resolver: EpisodeSourceResolver | undefined,
    private readonly cutService: CutService,
    private readonly skipService?: SkipService,
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

  public async createAutomaticCut(
    request: AutomaticUpstreamCutRequest,
  ): Promise<
    UpstreamCutResponse & {
      skipPlan: {
        policy: AutomaticCutPolicy;
        episodes: unknown[];
        automaticRemovals: readonly RemovedRange[];
        manualRemovals: readonly RemovedRange[];
        requestedRemovals: readonly RemovedRange[];
        warnings: readonly string[];
      };
    }
  > {
    if (this.resolver === undefined)
      throw new StremioUpstreamNotConfiguredError();
    if (this.skipService === undefined) {
      throw new Error("Skip timestamp providers are not configured.");
    }
    const selection = await this.resolver.resolve(request.episodes, {
      allowMixedSources: request.allowMixedSources ?? false,
    });
    const prepared = await this.cutService.prepareSources(
      selection.episodes.map((episode) => episode.mediaSource),
    );
    const preparedByEpisode = new Map(
      prepared.map((item) => [item.source.episodeId, item]),
    );
    const skipResolutions = await this.skipService.resolve(
      request.episodes.map((reference) => ({
        reference,
        durationSeconds: this.preparedDuration(preparedByEpisode, reference),
      })),
    );
    const policy: AutomaticCutPolicy = {
      ...DEFAULT_AUTOMATIC_CUT_POLICY,
      ...request.cutPolicy,
    };
    const plan = buildAutomaticCutPlan(skipResolutions, policy);
    const manualRemovals = request.remove ?? [];
    const requestedRemovals = mergeRemovalRanges([
      ...plan.automaticRemovals,
      ...manualRemovals,
    ]);
    const cut = this.cutService.createCutFromPreparedSources({
      sources: prepared,
      remove: requestedRemovals,
      ...(request.alignmentPolicy === undefined
        ? {}
        : { alignmentPolicy: request.alignmentPolicy }),
      ...(request.strictAlignment === undefined
        ? {}
        : { strictAlignment: request.strictAlignment }),
    });
    return {
      ...cut,
      selection: sanitizeCandidateSelection(selection),
      skipPlan: {
        policy,
        episodes: plan.episodes.map((episode, index) => ({
          ...sanitizeSkipResolution(skipResolutions[index]!),
          segments: episode.segments,
        })),
        automaticRemovals: plan.automaticRemovals,
        manualRemovals,
        requestedRemovals,
        warnings: plan.warnings,
      },
    };
  }

  private preparedDuration(
    preparedByEpisode: ReadonlyMap<string, PreparedInputSource>,
    reference: UpstreamEpisodeReference,
  ): number {
    const source = preparedByEpisode.get(reference.episodeId);
    if (source === undefined) {
      throw new Error(`Missing normalized source for ${reference.episodeId}.`);
    }
    return source.playlist.duration;
  }
}
