import type {
  CutAlignmentPolicy,
  RemovedRange,
  SafeSourceSkipSegment,
} from "@animetvcut/core";
import {
  buildAutomaticCutPlan,
  DEFAULT_AUTOMATIC_CUT_POLICY,
  mergeRemovalRanges,
  type AutomaticCutPolicy,
} from "@animetvcut/skip-providers";

import type {
  ChapterEpisodeInput,
  CutService,
  DevCutResponse,
  PreparedInputSource,
} from "./cut-service.js";
import {
  MediaFlowInvalidResponseError,
  MediaFlowSourceError,
  MediaFlowUnavailableError,
} from "./mediaflow/errors.js";
import { sanitizeSkipResolution, type SkipService } from "./skip-service.js";
import { StremioUpstreamNotConfiguredError } from "./stremio-upstream/errors.js";
import { sanitizeCandidateSelection } from "./stremio-upstream/resolver.js";
import type {
  CandidateFamilySelection,
  EpisodeSourceResolver,
  SanitizedCandidateSelection,
  UpstreamEpisodeReference,
} from "./stremio-upstream/types.js";
import type {
  SubtitleService,
  PublicSubtitleTrack,
} from "./subtitle-service.js";

export interface UpstreamCutRequest {
  episodes: readonly UpstreamEpisodeReference[];
  remove: RemovedRange[];
  allowMixedSources?: boolean;
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
}

export interface UpstreamCutResponse extends DevCutResponse {
  selection: SanitizedCandidateSelection;
  subtitleTracks?: readonly PublicSubtitleTrack[];
}

export interface AutomaticUpstreamCutRequest {
  episodes: readonly UpstreamEpisodeReference[];
  remove?: RemovedRange[];
  cutPolicy?: Partial<AutomaticCutPolicy>;
  allowMixedSources?: boolean;
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
  chapterEpisodes?: readonly ChapterEpisodeInput[];
  maxMediaSegments?: number;
  maxManifestBytes?: number;
  expectedEpisodeDurationSeconds?: number;
}

export interface LongAutomaticUpstreamCutRequest extends Omit<
  AutomaticUpstreamCutRequest,
  "episodes" | "allowMixedSources"
> {
  seasons: readonly {
    season: number;
    episodes: readonly UpstreamEpisodeReference[];
  }[];
  seasonConcurrency: number;
}

export interface SanitizedSeasonFamily {
  season: number;
  method: "binge_group" | "filename_family";
  episodeCount: number;
}

class ImplausibleNormalizedDurationError extends Error {}

export function isStructurallyPlausibleEpisodeDuration(
  durationSeconds: number,
  expectedSeconds?: number,
): boolean {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 60 &&
    durationSeconds <= 12 * 60 * 60 &&
    (expectedSeconds === undefined ||
      !Number.isFinite(expectedSeconds) ||
      expectedSeconds <= 0 ||
      durationSeconds >= expectedSeconds * 0.25)
  );
}

export class UpstreamCutService {
  public constructor(
    private readonly resolver: EpisodeSourceResolver | undefined,
    private readonly cutService: CutService,
    private readonly skipService?: SkipService,
    private readonly subtitleService?: SubtitleService,
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
    const excludedCandidates = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const selection = await this.resolver.resolve(request.episodes, {
        allowMixedSources: request.allowMixedSources ?? false,
        excludedCandidates,
      });
      try {
        return await this.createAutomaticCutFromSelection(request, selection);
      } catch (error) {
        if (!this.isRetryableSourceFailure(error)) throw error;
        lastError = error;
        for (const episode of selection.episodes) {
          excludedCandidates.add(
            `${episode.episodeId}:${episode.upstreamRank}`,
          );
        }
      }
    }
    throw lastError;
  }

  public async createLongAutomaticCut(
    request: LongAutomaticUpstreamCutRequest,
  ): Promise<
    Awaited<ReturnType<UpstreamCutService["createAutomaticCut"]>> & {
      families: readonly SanitizedSeasonFamily[];
    }
  > {
    if (this.resolver === undefined)
      throw new StremioUpstreamNotConfiguredError();
    const excludedCandidates = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const selections = new Array<{
        season: number;
        selection: CandidateFamilySelection;
      }>(request.seasons.length);
      let nextIndex = 0;
      const workers = Array.from(
        {
          length: Math.min(request.seasonConcurrency, request.seasons.length),
        },
        async () => {
          while (nextIndex < request.seasons.length) {
            const index = nextIndex++;
            const season = request.seasons[index]!;
            const selection = await this.resolver!.resolve(season.episodes, {
              allowMixedSources: false,
              excludedCandidates,
            });
            if (selection.familyMethod === "mixed")
              throw new Error("Long Cut season selection must be strict.");
            selections[index] = { season: season.season, selection };
          }
        },
      );
      await Promise.all(workers);
      const combined: CandidateFamilySelection = {
        familyMethod:
          selections.length === 1
            ? selections[0]!.selection.familyMethod
            : "mixed",
        familyKey:
          selections.length === 1
            ? selections[0]!.selection.familyKey
            : "per-season",
        episodes: selections.flatMap(({ selection }) => [
          ...selection.episodes,
        ]),
        unsupported: selections.reduce(
          (total, { selection }) => ({
            torrent: total.torrent + selection.unsupported.torrent,
            usenet: total.usenet + selection.unsupported.usenet,
            archive: total.archive + selection.unsupported.archive,
            youtube: total.youtube + selection.unsupported.youtube,
            external: total.external + selection.unsupported.external,
            unsupported: total.unsupported + selection.unsupported.unsupported,
          }),
          {
            torrent: 0,
            usenet: 0,
            archive: 0,
            youtube: 0,
            external: 0,
            unsupported: 0,
          },
        ),
        warnings: selections.flatMap(({ selection }) => [
          ...selection.warnings,
        ]),
      };
      const episodes = request.seasons.flatMap((season) => [
        ...season.episodes,
      ]);
      try {
        const result = await this.createAutomaticCutFromSelection(
          { ...request, episodes },
          combined,
        );
        return {
          ...result,
          families: selections.map(({ season, selection }) => ({
            season,
            method: selection.familyMethod as "binge_group" | "filename_family",
            episodeCount: selection.episodes.length,
          })),
        };
      } catch (error) {
        if (!this.isRetryableSourceFailure(error)) throw error;
        lastError = error;
        for (const episode of combined.episodes) {
          excludedCandidates.add(
            `${episode.episodeId}:${episode.upstreamRank}`,
          );
        }
      }
    }
    throw lastError ?? new Error("Long Cut source preparation failed.");
  }

  private async createAutomaticCutFromSelection(
    request: AutomaticUpstreamCutRequest,
    selection: CandidateFamilySelection,
  ) {
    if (this.skipService === undefined) {
      throw new Error("Skip timestamp providers are not configured.");
    }
    const prepared = await this.cutService.prepareSources(
      selection.episodes.map((episode) => episode.mediaSource),
    );
    this.validatePreparedDurations(
      prepared,
      request.expectedEpisodeDurationSeconds,
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
      ...(request.chapterEpisodes === undefined
        ? {}
        : { chapterEpisodes: request.chapterEpisodes }),
      ...(request.maxMediaSegments === undefined
        ? {}
        : { maxMediaSegments: request.maxMediaSegments }),
      ...(request.maxManifestBytes === undefined
        ? {}
        : { maxManifestBytes: request.maxManifestBytes }),
    });
    this.cutService.attachOutputSkipSegments(
      cut.cutId,
      plan.episodes.flatMap((episode): SafeSourceSkipSegment[] =>
        episode.segments.flatMap((segment) => {
          if (
            !segment.automaticRemoval ||
            segment.unsafeReason !== undefined ||
            segment.end === null ||
            !Number.isFinite(segment.start) ||
            !Number.isFinite(segment.end) ||
            segment.start < 0 ||
            segment.end <= segment.start ||
            segment.decision === "unsafe_ignored"
          )
            return [];
          return [
            {
              sourceEpisodeId: episode.episodeId,
              type: segment.type,
              start: segment.start,
              end: segment.end,
              decision: segment.decision === "remove" ? "remove" : "keep",
            },
          ];
        }),
      ),
    );
    const subtitleTracks = await this.subtitleService?.discover(
      cut.cutId,
      selection,
    );
    return {
      ...cut,
      ...(subtitleTracks === undefined ? {} : { subtitleTracks }),
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

  private validatePreparedDurations(
    prepared: readonly PreparedInputSource[],
    expectedSeconds?: number,
  ): void {
    if (
      expectedSeconds === undefined ||
      !Number.isFinite(expectedSeconds) ||
      expectedSeconds <= 0
    )
      return;
    const invalid = prepared.find(
      ({ playlist }) =>
        !isStructurallyPlausibleEpisodeDuration(
          playlist.duration,
          expectedSeconds,
        ),
    );
    if (invalid !== undefined) {
      throw new ImplausibleNormalizedDurationError(
        "Normalized episode duration is structurally implausible; refusing a broken cut.",
      );
    }
  }

  private isRetryableSourceFailure(error: unknown): boolean {
    return (
      error instanceof ImplausibleNormalizedDurationError ||
      error instanceof MediaFlowUnavailableError ||
      error instanceof MediaFlowInvalidResponseError ||
      error instanceof MediaFlowSourceError
    );
  }
}
