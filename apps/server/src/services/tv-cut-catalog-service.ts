import { OperationMetrics } from "./operation-metrics.js";
import {
  CutUnavailableError,
  availabilityMessages,
  explainCutFailure,
} from "./cut-availability.js";
import { createHash } from "node:crypto";

import {
  BoundedCache,
  groupTvCutEpisodes,
  planLongCuts,
  type LongFormCutMode,
  type PlannedLongSeason,
  type PlannedLongSeries,
  type TvCutGroup,
  type TvCutGroupingConfig,
} from "@animetvcut/core";
import {
  InvalidVirtualStremioIdError,
  createLongFormVirtualMetaId,
  createSeasonCutVideoId,
  createSeriesCutVersion,
  createSeriesCutVideoId,
  createVirtualMetaId,
  createVirtualVideoId,
  parseLongFormVirtualMetaId,
  parseSeasonCutVideoId,
  parseSeriesCutVideoId,
  parseVirtualVideoId,
  type MetadataStremioClient,
  type MetadataStremioStats,
  type SourceEpisodeMeta,
  type SourceSeriesMeta,
  type StremioMetaPreview,
} from "@animetvcut/stremio";

import type { CutService } from "./cut-service.js";
import {
  DEFAULT_LONG_CUT_CONFIGURATION,
  type LongCutConfiguration,
} from "./metadata-config.js";
import type { UpstreamCutService } from "./upstream-cut-service.js";

import {
  encodePreferences,
  cutPolicyFor,
  type PlaybackPreferences,
} from "./playback-preferences.js";

// Some Stremio clients (Stremio Kai) resolve a catalog meta item to IMDb
// before rendering it. AIOMetadata search items carry an IMDb-shaped id but
// leave imdb_id null, so expose the IMDb anchor explicitly on the virtual
// items when the source id is an IMDb id.
function imdbIdOf(meta: Pick<StremioMetaPreview, "id" | "imdb_id">) {
  const explicit = meta.imdb_id;
  if (explicit !== undefined && /^tt\d+$/.test(explicit)) return explicit;
  return /^tt\d+$/.test(meta.id) ? meta.id : undefined;
}

interface CachedStream {
  expiresAt: number;
  cutId: string;
  response: PublicStreamResponse;
}

interface StreamBuild {
  controller: AbortController;
  promise: Promise<PublicStreamResponse>;
  waiters: number;
}

export interface PlannedTvCutGroup extends TvCutGroup {
  virtualVideoId: string;
  part: number;
}

export interface PlannedSeasonCut extends PlannedLongSeason {
  virtualVideoId?: string;
}

export interface PlannedCompleteCut extends PlannedLongSeries {
  version?: string;
  virtualVideoId?: string;
}

export interface PlannedSeries {
  source: SourceSeriesMeta;
  virtualMetaId: string;
  groups: readonly PlannedTvCutGroup[];
  seasonCuts: readonly PlannedSeasonCut[];
  seriesCut: PlannedCompleteCut;
  warnings: readonly string[];
}

interface CutScope {
  mode: LongFormCutMode;
  sourceSeriesId: string;
  episodes: readonly SourceEpisodeMeta[];
  title: string;
  estimatedDurationSeconds: number;
  malAnimeId?: number;
  kitsuAnimeId?: number;
  season?: number;
  version?: string;
}

export interface PublicStreamResponse {
  streams: readonly {
    name: string;
    title: string;
    url: string;
    subtitles?: readonly { id: string; url: string; lang: string }[];
    behaviorHints: { bingeGroup: string; notWebReady: true };
  }[];
}

const MODE_NAMES: Readonly<Record<LongFormCutMode, string>> = {
  tv: "TV Cut",
  season: "Season Cut",
  series: "Complete Cut",
};

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 20);
}

function formatLongDuration(durationSeconds: number): string {
  const totalMinutes = Math.round(durationSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was aborted.");
}

async function awaitWithSignal<T>(
  shared: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return shared;
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const result = Promise.race([
    shared,
    new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  try {
    return await result;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export class TvCutCatalogService {
  private readonly streamCache = new BoundedCache<string, CachedStream>(
    256,
    () => this.now(),
  );
  private readonly streamInFlight = new Map<string, StreamBuild>();

  public close(): void {
    for (const build of this.streamInFlight.values()) build.controller.abort();
    this.streamInFlight.clear();
  }

  public constructor(
    private readonly metadataClient: MetadataStremioClient | undefined,
    private readonly upstreamCutService: UpstreamCutService,
    private readonly cutService: CutService,
    private readonly publicBaseUrl: URL | undefined,
    private readonly groupingConfig: TvCutGroupingConfig,
    private readonly now: () => number = Date.now,
    private readonly streamCacheTtlMs = 5 * 60 * 1000,
    private readonly longCuts: LongCutConfiguration = DEFAULT_LONG_CUT_CONFIGURATION,
    private readonly maxInFlightBuilds = 8,
    private readonly preferences: PlaybackPreferences = {},
    private readonly metrics = new OperationMetrics(),
    private readonly canStartBuild: () => boolean = () => true,
  ) {
    if (!Number.isSafeInteger(maxInFlightBuilds) || maxInFlightBuilds < 1)
      throw new Error("Stream build limit must be a positive integer.");
  }

  public get profileKey(): string {
    return stableHash(encodePreferences(this.preferences));
  }

  public get activeBuilds(): number {
    return this.streamInFlight.size;
  }

  public get configured(): boolean {
    return this.metadataClient !== undefined;
  }

  public get metadataStats(): Readonly<MetadataStremioStats> | undefined {
    return this.metadataClient?.stats;
  }

  public get metadataSearchCatalogId(): string | undefined {
    return this.metadataClient?.searchCatalogId;
  }

  public cutSession(cutId: string) {
    return this.cutService.session(cutId);
  }

  public async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly StremioMetaPreview[]> {
    const source = await this.requireClient().searchSeries(query, 0, signal);
    const modes: LongFormCutMode[] = [
      ...(this.longCuts.exposeTv ? (["tv"] as const) : []),
      ...(this.longCuts.exposeSeason ? (["season"] as const) : []),
      ...(this.longCuts.exposeSeries ? (["series"] as const) : []),
    ];
    return source.flatMap((meta) =>
      modes.map((mode) => ({
        ...meta,
        id: createLongFormVirtualMetaId(mode, meta.id),
        name: `${meta.name} — ${MODE_NAMES[mode]}`,
        ...(imdbIdOf(meta) === undefined ? {} : { imdb_id: imdbIdOf(meta) }),
      })),
    );
  }

  public async planByVirtualMetaId(
    virtualMetaId: string,
    signal?: AbortSignal,
  ): Promise<PlannedSeries> {
    const { sourceId } = parseLongFormVirtualMetaId(virtualMetaId);
    return this.planBySourceId(sourceId, signal);
  }

  public async planBySourceId(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<PlannedSeries> {
    const source = await this.requireClient().getSeriesMeta(sourceId, signal);
    const groupable = source.videos.map((episode) => ({
      sourceId: episode.id,
      season: episode.season,
      episode: episode.episode,
      ...(episode.title === undefined ? {} : { title: episode.title }),
      ...(episode.released === undefined ? {} : { released: episode.released }),
      runtimeSeconds:
        episode.runtimeSeconds ??
        source.runtimeSeconds ??
        this.groupingConfig.fallbackRuntimeSeconds,
    }));
    const tv = groupTvCutEpisodes(groupable, {
      now: this.now(),
      config: this.groupingConfig,
    });
    const partBySeason = new Map<number, number>();
    const groups = tv.groups.map((group) => {
      const part = (partBySeason.get(group.season) ?? 0) + 1;
      partBySeason.set(group.season, part);
      return {
        ...group,
        part,
        virtualVideoId: createVirtualVideoId(
          source.id,
          group.season,
          group.firstEpisode,
          group.lastEpisode,
        ),
      };
    });
    const long = planLongCuts(groupable, {
      now: this.now(),
      config: this.longCuts.planning,
    });
    const seasonCuts = long.seasonCuts.map((season) => ({
      ...season,
      ...(season.eligible && season.episodes.length > 0
        ? {
            virtualVideoId: createSeasonCutVideoId(
              source.id,
              season.season,
              season.episodes[0]!.episode,
              season.episodes.at(-1)!.episode,
            ),
          }
        : {}),
    }));
    const versionEpisodes = long.seriesCut.episodes.map((episode) => ({
      id: episode.sourceId,
      season: episode.season,
      episode: episode.episode,
    }));
    const seriesCut: PlannedCompleteCut = long.seriesCut.eligible
      ? {
          ...long.seriesCut,
          version: createSeriesCutVersion(versionEpisodes),
          virtualVideoId: createSeriesCutVideoId(source.id, versionEpisodes),
        }
      : long.seriesCut;
    return {
      source,
      virtualMetaId: createVirtualMetaId(source.id),
      groups,
      seasonCuts,
      seriesCut,
      warnings: tv.warnings,
    };
  }

  public async longCutDiagnostics(sourceId: string, signal?: AbortSignal) {
    const plan = await this.planBySourceId(sourceId, signal);
    return {
      sourceSeriesId: sourceId,
      seasonCuts: plan.seasonCuts.map((season) => ({
        season: season.season,
        eligible: season.eligible,
        episodes: season.episodes.length,
        estimatedDurationSeconds: season.estimatedDurationSeconds,
        ...(season.virtualVideoId === undefined
          ? {}
          : { virtualVideoId: season.virtualVideoId }),
        ...(season.reason === undefined ? {} : { reason: season.reason }),
        warnings: season.warnings,
      })),
      seriesCut: {
        eligible: plan.seriesCut.eligible,
        episodes: plan.seriesCut.episodes.length,
        estimatedDurationSeconds: plan.seriesCut.estimatedDurationSeconds,
        ...(plan.seriesCut.version === undefined
          ? {}
          : { version: plan.seriesCut.version }),
        ...(plan.seriesCut.virtualVideoId === undefined
          ? {}
          : { virtualVideoId: plan.seriesCut.virtualVideoId }),
        ...(plan.seriesCut.reason === undefined
          ? {}
          : { reason: plan.seriesCut.reason }),
      },
    };
  }

  public failureResponse(
    error: unknown,
    virtualVideoId: string,
    profile?: string,
  ) {
    if (this.publicBaseUrl === undefined) return { streams: [] };
    const explanation = explainCutFailure(error);
    const url = new URL(
      profile === undefined ? "configure" : `p/${profile}/configure`,
      this.publicBaseUrl,
    );
    url.hash = new URLSearchParams({ cut: virtualVideoId }).toString();
    return {
      streams: [
        {
          name: "AnimeTVCut",
          title: `${explanation.message}\nOpen details to retry or adjust preferences.`,
          externalUrl: url.href,
        },
      ],
    };
  }

  public async previewPlan(virtualMetaId: string, signal?: AbortSignal) {
    const { mode, sourceId } = parseLongFormVirtualMetaId(virtualMetaId);
    this.requireModeEnabled(mode);
    const plan = await this.planBySourceId(sourceId, signal);
    const describe = (
      available: boolean,
      reason?: keyof typeof availabilityMessages,
    ) => ({
      available,
      ...(available
        ? {}
        : {
            reason: reason ?? "still_airing",
            message: availabilityMessages[reason ?? "still_airing"],
          }),
    });
    const cuts =
      mode === "tv"
        ? plan.groups
            .filter((group) => group.season > 0)
            .map((group) => ({
              id: group.virtualVideoId,
              title: `Season ${group.season} · Part ${group.part} · Episodes ${group.firstEpisode}–${group.lastEpisode}`,
              estimatedDurationSeconds: group.estimatedDurationSeconds,
              episodes: group.episodes.length,
              ...describe(group.finalized),
            }))
        : mode === "season"
          ? plan.seasonCuts.map((season) => ({
              id: season.virtualVideoId,
              title: `Season ${season.season}`,
              estimatedDurationSeconds: season.estimatedDurationSeconds,
              episodes: season.episodes.length,
              ...describe(season.eligible, season.reason),
            }))
          : [
              {
                id: plan.seriesCut.virtualVideoId,
                title: "Complete Series",
                episodes: plan.seriesCut.episodes.length,
                estimatedDurationSeconds:
                  plan.seriesCut.estimatedDurationSeconds,
                ...describe(plan.seriesCut.eligible, plan.seriesCut.reason),
              },
            ];
    return { name: plan.source.name, mode, cuts };
  }

  public async previewCut(virtualVideoId: string, signal?: AbortSignal) {
    const scope = await this.validateScope(virtualVideoId, signal);
    const response = await this.publicStream(virtualVideoId, signal);
    const playlistUrl = response.streams[0]?.url;
    if (playlistUrl === undefined) throw new CutUnavailableError("unavailable");
    const cutId = /\/media\/cut\/([^/]+)\//.exec(
      new URL(playlistUrl).pathname,
    )?.[1];
    const session =
      cutId === undefined ? undefined : this.cutService.session(cutId);
    if (session === undefined) throw new CutUnavailableError("invalid_cut");
    const episodeLabel = (id: string) => {
      const episode = scope.episodes.find((episode) => episode.id === id);
      return episode === undefined
        ? "an included episode"
        : `season ${episode.season}, episode ${episode.episode}`;
    };
    const warnings = (session.skipDiagnostics?.episodes ?? []).flatMap(
      (episode) =>
        (["opening", "ending"] as const).flatMap((type) =>
          episode.segments.some(
            (segment) =>
              segment.type === type &&
              segment.automaticRemoval &&
              segment.end !== null,
          )
            ? []
            : [
                `No verified ${type} for ${episodeLabel(episode.episodeId)}; footage is retained.`,
              ],
        ),
    );
    return {
      title: scope.title,
      estimatedDurationSeconds: scope.estimatedDurationSeconds,
      duration: session.duration,
      playlistUrl,
      episodes: scope.episodes.map(({ id, season, episode, title }) => ({
        id,
        season,
        episode,
        title,
      })),
      removals: session.appliedCuts.flatMap((cut) =>
        cut.status === "applied"
          ? [
              {
                episodeId: cut.episodeId,
                type: cut.type,
                start: cut.appliedStart,
                end: cut.appliedEnd,
                requestedStart: cut.requestedStart,
                requestedEnd: cut.requestedEnd,
              },
            ]
          : [],
      ),
      warnings: [
        ...warnings,
        ...session.appliedCuts
          .filter((cut) => cut.status !== "applied")
          .map(
            (cut) =>
              `No safe ${cut.type} boundary for ${episodeLabel(cut.episodeId)}; footage is retained.`,
          ),
      ],
    };
  }

  public async publicMeta(
    virtualMetaId: string,
    signal?: AbortSignal,
  ): Promise<{ meta: Record<string, unknown> }> {
    const coordinates = parseLongFormVirtualMetaId(virtualMetaId);
    this.requireModeEnabled(coordinates.mode);
    const plan = await this.planBySourceId(coordinates.sourceId, signal);
    const source = plan.source;
    const base = {
      id: createLongFormVirtualMetaId(coordinates.mode, source.id),
      type: "series",
      name: `${source.name} — ${MODE_NAMES[coordinates.mode]}`,
      ...(source.poster === undefined ? {} : { poster: source.poster }),
      ...(source.posterShape === undefined
        ? {}
        : { posterShape: source.posterShape }),
      ...(source.background === undefined
        ? {}
        : { background: source.background }),
      ...(source.logo === undefined ? {} : { logo: source.logo }),
      ...(source.description === undefined
        ? {}
        : { description: source.description }),
      ...(source.releaseInfo === undefined
        ? {}
        : { releaseInfo: source.releaseInfo }),
      ...(source.imdbRating === undefined
        ? {}
        : { imdbRating: source.imdbRating }),
      ...(imdbIdOf(source) === undefined ? {} : { imdb_id: imdbIdOf(source) }),
      ...(source.genres === undefined ? {} : { genres: source.genres }),
      ...(source.runtimeSeconds === undefined
        ? {}
        : { runtime: `${Math.ceil(source.runtimeSeconds / 60)} min` }),
    };
    const videos =
      coordinates.mode === "tv"
        ? plan.groups
            // Metadata providers commonly put shorts/mini-anime in season 0.
            // Showing them first makes Stremio open a short "Part 1" instead
            // of the actual series. Existing season-zero video IDs remain
            // valid, but the main TV Cut listing contains normal seasons.
            .filter((group) => group.finalized && group.season > 0)
            .map((group) => ({
              id: group.virtualVideoId,
              title: `Part ${group.part} (Episodes ${group.firstEpisode}–${group.lastEpisode})`,
              season: group.season,
              episode: group.part,
              ...(group.latestRelease === undefined
                ? {}
                : { released: group.latestRelease }),
            }))
        : coordinates.mode === "season"
          ? plan.seasonCuts
              .filter(
                (
                  season,
                ): season is PlannedSeasonCut & {
                  virtualVideoId: string;
                } => season.eligible && season.virtualVideoId !== undefined,
              )
              .map((season) => ({
                id: season.virtualVideoId,
                title: `Season ${season.season} — Complete (Episodes ${season.episodes[0]!.episode}–${season.episodes.at(-1)!.episode})`,
                season: season.season,
                episode: 1,
                ...(season.newestRelease === undefined
                  ? {}
                  : { released: season.newestRelease }),
              }))
          : plan.seriesCut.eligible &&
              plan.seriesCut.virtualVideoId !== undefined
            ? [
                {
                  id: plan.seriesCut.virtualVideoId,
                  title: `Complete Series — ${plan.seriesCut.episodes.length} Episodes`,
                  season: 1,
                  episode: 1,
                },
              ]
            : [];
    const pendingReason =
      coordinates.mode === "season"
        ? plan.seasonCuts.find((cut) => !cut.eligible)?.reason
        : coordinates.mode === "series"
          ? plan.seriesCut.reason
          : "still_airing";
    return {
      meta: {
        ...base,
        ...(videos.length === 0
          ? {
              description: [
                base.description,
                availabilityMessages[pendingReason ?? "invalid_cut"],
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
        videos,
      },
    };
  }

  public async publicStream(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<PublicStreamResponse> {
    if (this.publicBaseUrl === undefined)
      throw new Error("PUBLIC_BASE_URL is not configured.");
    signal?.throwIfAborted();
    const cached = this.streamCache.get(virtualVideoId);
    if (
      cached !== undefined &&
      cached.expiresAt > this.now() &&
      this.cutService.isCutActive(cached.cutId)
    )
      return cached.response;
    let build = this.streamInFlight.get(virtualVideoId);
    if (build === undefined) {
      if (
        this.streamInFlight.size >= this.maxInFlightBuilds ||
        !this.canStartBuild()
      )
        throw new CutUnavailableError("capacity");
      const controller = new AbortController();
      const mode = virtualVideoId.startsWith("atc:season:")
        ? "season"
        : virtualVideoId.startsWith("atc:series:")
          ? "series"
          : "tv";
      const promise = this.metrics.measure(`cut_${mode}`, () =>
        this.createPublicStream(virtualVideoId, controller.signal),
      );
      build = { controller, promise, waiters: 0 };
      this.streamInFlight.set(virtualVideoId, build);
      const shared = build;
      void promise
        .finally(() => {
          if (this.streamInFlight.get(virtualVideoId) === shared)
            this.streamInFlight.delete(virtualVideoId);
        })
        .catch(() => {});
    }
    build.waiters += 1;
    try {
      return await awaitWithSignal(build.promise, signal);
    } finally {
      build.waiters -= 1;
      if (
        build.waiters === 0 &&
        this.streamInFlight.get(virtualVideoId) === build
      ) {
        this.streamInFlight.delete(virtualVideoId);
        build.controller.abort();
      }
    }
  }

  private async createPublicStream(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<PublicStreamResponse> {
    const scope = await this.validateScope(virtualVideoId, signal);
    this.requireModeEnabled(scope.mode);
    const sourceImdbId = /^tt\d{7,8}$/.test(scope.sourceSeriesId)
      ? scope.sourceSeriesId
      : undefined;
    const references = scope.episodes.map((episode) => {
      const malAnimeId = this.malAnimeIdForEpisode(scope, episode);
      const hasImdbIdentity = sourceImdbId !== undefined && episode.season >= 1;
      return {
        episodeId: episode.id,
        type: "series",
        videoId: episode.id,
        ...(!hasImdbIdentity && malAnimeId === undefined
          ? {}
          : {
              skipIdentity: {
                ...(hasImdbIdentity
                  ? {
                      imdbId: sourceImdbId,
                      imdbSeason: episode.season,
                      imdbEpisode: episode.episode,
                    }
                  : {}),
                ...(malAnimeId === undefined
                  ? {}
                  : { malAnimeId, malEpisode: episode.episode }),
              },
            }),
      };
    });
    const chapterEpisodes = scope.episodes.map((episode) => ({
      sourceEpisodeId: episode.id,
      season: episode.season,
      episode: episode.episode,
      ...(episode.title === undefined ? {} : { title: episode.title }),
    }));
    const cut =
      scope.mode === "tv"
        ? await this.upstreamCutService.createAutomaticCut({
            episodes: references,
            cutPolicy: cutPolicyFor(this.preferences),
            preferences: this.preferences,
            chapterEpisodes,
            expectedEpisodeDurationSeconds:
              scope.estimatedDurationSeconds / scope.episodes.length,
            signal,
          })
        : await this.upstreamCutService.createLongAutomaticCut({
            seasons: [
              ...new Set(scope.episodes.map((item) => item.season)),
            ].map((season) => ({
              season,
              episodes: references.filter(
                (_, index) => scope.episodes[index]!.season === season,
              ),
            })),
            seasonConcurrency: this.longCuts.seasonPrepareConcurrency,
            cutPolicy: cutPolicyFor(this.preferences),
            preferences: this.preferences,
            chapterEpisodes,
            maxMediaSegments: this.longCuts.maxMediaSegments,
            maxManifestBytes: this.longCuts.maxManifestBytes,
            sourcePrepareConcurrency: this.longCuts.sourcePrepareConcurrency,
            expectedEpisodeDurationSeconds:
              scope.estimatedDurationSeconds / scope.episodes.length,
            signal,
          });
    signal?.throwIfAborted();
    if (scope.mode !== "tv" && "families" in cut) {
      const families = cut.families as readonly {
        season: number;
        method: "binge_group" | "filename_family";
        episodeCount: number;
      }[];
      const session = this.cutService.session(cut.cutId);
      if (session !== undefined) {
        const automatic = cut.skipPlan.automaticRemovals;
        session.longFormDiagnostics = {
          mode: scope.mode,
          families,
          skip: {
            openingRequested: automatic.filter(
              (range) => range.type === "opening",
            ).length,
            openingApplied: cut.appliedCuts.filter(
              (range) => range.type === "opening" && range.status === "applied",
            ).length,
            endingRequested: automatic.filter(
              (range) => range.type === "ending",
            ).length,
            endingApplied: cut.appliedCuts.filter(
              (range) => range.type === "ending" && range.status === "applied",
            ).length,
            unsafeSegmentsRetained:
              cut.skipPlan.episodes
                .flatMap(
                  (episode) =>
                    (episode as { segments?: readonly { decision?: string }[] })
                      .segments ?? [],
                )
                .filter((segment) => segment.decision === "unsafe_ignored")
                .length +
              cut.appliedCuts.filter((range) => range.status !== "applied")
                .length,
          },
        };
      }
    }
    this.cutService.enableWatchProgress(
      cut.cutId,
      scope.episodes.map((episode) => episode.id),
    );
    const response: PublicStreamResponse = {
      streams: [
        {
          name: "AnimeTVCut",
          title:
            scope.mode === "tv"
              ? scope.title
              : `${scope.title} · ${formatLongDuration(cut.duration)}`,
          url: new URL(cut.playlistUrl.slice(1), this.publicBaseUrl).toString(),
          ...(cut.subtitleTracks === undefined ||
          cut.subtitleTracks.length === 0
            ? {}
            : {
                subtitles: cut.subtitleTracks.map((track) => ({
                  id: `atc-${track.id}`,
                  url: new URL(
                    `media/cut/${cut.cutId}/subtitle/${track.id}.${track.extension}`,
                    this.publicBaseUrl,
                  ).toString(),
                  lang: track.lang,
                })),
              }),
          behaviorHints: {
            notWebReady: true,
            bingeGroup:
              scope.mode === "tv"
                ? `animetvcut-tv-${stableHash(`${scope.sourceSeriesId}\0automatic\0${this.profileKey}`)}`
                : `animetvcut-${scope.mode}-${stableHash(
                    `${scope.sourceSeriesId}\0${scope.season ?? ""}\0${scope.version ?? "automatic"}\0${this.profileKey}`,
                  )}`,
          },
        },
      ],
    };
    if (this.streamCacheTtlMs > 0)
      this.streamCache.set(virtualVideoId, {
        cutId: cut.cutId,
        response,
        expiresAt: this.now() + this.streamCacheTtlMs,
      });
    return response;
  }

  private async validateScope(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<CutScope> {
    if (virtualVideoId.startsWith("atc:tv:")) {
      const coordinates = parseVirtualVideoId(virtualVideoId);
      const plan = await this.planBySourceId(coordinates.sourceId, signal);
      const group = plan.groups.find(
        (candidate) =>
          candidate.finalized && candidate.virtualVideoId === virtualVideoId,
      );
      if (group === undefined)
        throw new CutUnavailableError(
          plan.groups.some(
            (candidate) =>
              candidate.virtualVideoId === virtualVideoId &&
              !candidate.finalized,
          )
            ? "still_airing"
            : "invalid_cut",
        );
      return {
        mode: "tv",
        sourceSeriesId: coordinates.sourceId,
        episodes: this.sourceEpisodes(plan.source, group.episodes),
        title: `TV Cut Part ${group.part} · Episodes ${group.firstEpisode}–${group.lastEpisode}`,
        estimatedDurationSeconds: group.estimatedDurationSeconds,
        ...(plan.source.malAnimeId === undefined
          ? {}
          : { malAnimeId: plan.source.malAnimeId }),
        ...(plan.source.kitsuAnimeId === undefined
          ? {}
          : { kitsuAnimeId: plan.source.kitsuAnimeId }),
        season: group.season,
      };
    }
    if (virtualVideoId.startsWith("atc:season:")) {
      const coordinates = parseSeasonCutVideoId(virtualVideoId);
      const plan = await this.planBySourceId(coordinates.sourceId, signal);
      const season = plan.seasonCuts.find(
        (candidate) =>
          candidate.eligible && candidate.virtualVideoId === virtualVideoId,
      );
      if (season === undefined)
        throw new CutUnavailableError(
          plan.seasonCuts.find(
            (candidate) => candidate.season === coordinates.season,
          )?.reason ?? "invalid_cut",
        );
      return {
        mode: "season",
        sourceSeriesId: coordinates.sourceId,
        episodes: this.sourceEpisodes(plan.source, season.episodes),
        title: `Season Cut · Episodes ${coordinates.firstEpisode}–${coordinates.lastEpisode}`,
        estimatedDurationSeconds: season.estimatedDurationSeconds,
        ...(plan.source.malAnimeId === undefined
          ? {}
          : { malAnimeId: plan.source.malAnimeId }),
        ...(plan.source.kitsuAnimeId === undefined
          ? {}
          : { kitsuAnimeId: plan.source.kitsuAnimeId }),
        season: coordinates.season,
      };
    }
    const coordinates = parseSeriesCutVideoId(virtualVideoId);
    const plan = await this.planBySourceId(coordinates.sourceId, signal);
    if (
      !plan.seriesCut.eligible ||
      plan.seriesCut.virtualVideoId !== virtualVideoId ||
      plan.seriesCut.version !== coordinates.version
    )
      throw new CutUnavailableError(plan.seriesCut.reason ?? "invalid_cut");
    return {
      mode: "series",
      sourceSeriesId: coordinates.sourceId,
      episodes: this.sourceEpisodes(plan.source, plan.seriesCut.episodes),
      title: `Complete Cut · ${plan.seriesCut.episodes.length} Episodes`,
      estimatedDurationSeconds: plan.seriesCut.estimatedDurationSeconds,
      ...(plan.source.malAnimeId === undefined
        ? {}
        : { malAnimeId: plan.source.malAnimeId }),
      ...(plan.source.kitsuAnimeId === undefined
        ? {}
        : { kitsuAnimeId: plan.source.kitsuAnimeId }),
      version: coordinates.version,
    };
  }

  private malAnimeIdForEpisode(
    scope: CutScope,
    episode: SourceEpisodeMeta,
  ): number | undefined {
    if (episode.season < 1) return undefined;
    const directMal = /^mal:(\d+):(\d+)$/.exec(episode.id);
    if (
      directMal?.[1] !== undefined &&
      directMal[2] !== undefined &&
      Number(directMal[2]) === episode.episode
    ) {
      const animeId = Number(directMal[1]);
      if (Number.isSafeInteger(animeId) && animeId > 0) return animeId;
    }
    if (scope.malAnimeId === undefined) return undefined;

    const kitsu = /^kitsu:(\d+):(\d+)$/.exec(episode.id);
    if (
      scope.kitsuAnimeId !== undefined &&
      kitsu?.[1] !== undefined &&
      kitsu[2] !== undefined &&
      Number(kitsu[1]) === scope.kitsuAnimeId &&
      Number(kitsu[2]) === episode.episode
    ) {
      return scope.malAnimeId;
    }

    const normalSeasons = new Set(
      scope.episodes
        .filter((candidate) => candidate.season >= 1)
        .map((candidate) => candidate.season),
    );
    const mappedSeason =
      scope.season ??
      (normalSeasons.size === 1 ? [...normalSeasons][0] : undefined);
    if (mappedSeason === undefined || mappedSeason !== episode.season) {
      return undefined;
    }

    // IMDb-backed propagation: ttXXXXXXX:season:episode
    const validImdbSeries = /^tt\d{7,8}$/.test(scope.sourceSeriesId);
    if (!validImdbSeries) return undefined;
    const imdbEp = /^tt(\d{7,8}):(\d+):(\d+)$/.exec(episode.id);
    if (
      imdbEp?.[1] !== undefined &&
      imdbEp[2] !== undefined &&
      imdbEp[3] !== undefined &&
      imdbEp[1] === scope.sourceSeriesId.slice(2) &&
      Number(imdbEp[2]) === episode.season &&
      Number(imdbEp[3]) === episode.episode
    ) {
      return scope.malAnimeId;
    }
    return undefined;
  }

  private sourceEpisodes(
    source: SourceSeriesMeta,
    planned: readonly { sourceId: string }[],
  ): SourceEpisodeMeta[] {
    const byId = new Map(source.videos.map((episode) => [episode.id, episode]));
    return planned.map((episode) => {
      const sourceEpisode = byId.get(episode.sourceId);
      if (sourceEpisode === undefined)
        throw new InvalidVirtualStremioIdError(
          "Planned source episode is missing from current metadata.",
        );
      return sourceEpisode;
    });
  }

  private requireModeEnabled(mode: LongFormCutMode): void {
    const enabled =
      mode === "tv"
        ? this.longCuts.exposeTv
        : mode === "season"
          ? this.longCuts.exposeSeason
          : this.longCuts.exposeSeries;
    if (!enabled) throw new CutUnavailableError("disabled");
  }

  private requireClient(): MetadataStremioClient {
    if (this.metadataClient === undefined)
      throw new Error("Metadata Stremio addon is not configured.");
    return this.metadataClient;
  }
}
