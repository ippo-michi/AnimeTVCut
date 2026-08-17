import { createHash } from "node:crypto";

import {
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

interface CachedStream {
  expiresAt: number;
  cutId: string;
  response: PublicStreamResponse;
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

export class TvCutCatalogService {
  private readonly streamCache = new Map<string, CachedStream>();
  private readonly streamInFlight = new Map<
    string,
    Promise<PublicStreamResponse>
  >();

  public constructor(
    private readonly metadataClient: MetadataStremioClient | undefined,
    private readonly upstreamCutService: UpstreamCutService,
    private readonly cutService: CutService,
    private readonly publicBaseUrl: URL | undefined,
    private readonly groupingConfig: TvCutGroupingConfig,
    private readonly now: () => number = Date.now,
    private readonly streamCacheTtlMs = 5 * 60 * 1000,
    private readonly longCuts: LongCutConfiguration = DEFAULT_LONG_CUT_CONFIGURATION,
  ) {}

  public get configured(): boolean {
    return this.metadataClient !== undefined;
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
    return { meta: { ...base, videos } };
  }

  public async publicStream(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<PublicStreamResponse> {
    if (this.publicBaseUrl === undefined)
      throw new Error("PUBLIC_BASE_URL is not configured.");
    const cached = this.streamCache.get(virtualVideoId);
    if (
      cached !== undefined &&
      cached.expiresAt > this.now() &&
      this.cutService.isCutActive(cached.cutId)
    )
      return cached.response;
    const inFlight = this.streamInFlight.get(virtualVideoId);
    if (inFlight !== undefined) return inFlight;
    const creating = this.createPublicStream(virtualVideoId, signal);
    this.streamInFlight.set(virtualVideoId, creating);
    try {
      return await creating;
    } finally {
      if (this.streamInFlight.get(virtualVideoId) === creating)
        this.streamInFlight.delete(virtualVideoId);
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
            chapterEpisodes,
            expectedEpisodeDurationSeconds:
              scope.estimatedDurationSeconds / scope.episodes.length,
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
            chapterEpisodes,
            maxMediaSegments: this.longCuts.maxMediaSegments,
            maxManifestBytes: this.longCuts.maxManifestBytes,
            expectedEpisodeDurationSeconds:
              scope.estimatedDurationSeconds / scope.episodes.length,
          });
    this.cutService.enableWatchProgress(
      cut.cutId,
      scope.episodes.map((episode) => episode.id),
    );
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
                ? `animetvcut-tv-${stableHash(`${scope.sourceSeriesId}\0automatic`)}`
                : `animetvcut-${scope.mode}-${stableHash(
                    `${scope.sourceSeriesId}\0${scope.season ?? ""}\0${scope.version ?? "automatic"}`,
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
        throw new InvalidVirtualStremioIdError(
          "Virtual TV Cut is not present in the current finalized grouping plan.",
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
        throw new InvalidVirtualStremioIdError(
          "Season Cut is not present in the current finalized plan.",
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
      throw new InvalidVirtualStremioIdError(
        "Complete Cut is not present in the current finalized plan.",
      );
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
    if (!enabled)
      throw new InvalidVirtualStremioIdError("Cut mode is disabled.");
  }

  private requireClient(): MetadataStremioClient {
    if (this.metadataClient === undefined)
      throw new Error("Metadata Stremio addon is not configured.");
    return this.metadataClient;
  }
}
