import { createHash } from "node:crypto";

import {
  groupTvCutEpisodes,
  type TvCutGroup,
  type TvCutGroupingConfig,
} from "@animetvcut/core";
import {
  InvalidVirtualStremioIdError,
  createVirtualMetaId,
  createVirtualVideoId,
  parseVirtualMetaId,
  parseVirtualVideoId,
  type MetadataStremioClient,
  type SourceSeriesMeta,
  type StremioMetaPreview,
} from "@animetvcut/stremio";

import type { CutService } from "./cut-service.js";
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

export interface PlannedSeries {
  source: SourceSeriesMeta;
  virtualMetaId: string;
  groups: readonly PlannedTvCutGroup[];
  warnings: readonly string[];
}

export interface PublicStreamResponse {
  streams: readonly {
    name: string;
    title: string;
    url: string;
    behaviorHints: { bingeGroup: string };
  }[];
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
  ) {}

  public get configured(): boolean {
    return this.metadataClient !== undefined;
  }

  public async search(
    query: string,
    skip = 0,
    signal?: AbortSignal,
  ): Promise<readonly StremioMetaPreview[]> {
    const client = this.requireClient();
    return (await client.searchSeries(query, skip, signal)).map((meta) => ({
      ...meta,
      id: createVirtualMetaId(meta.id),
      name: `${meta.name} — TV Cut`,
    }));
  }

  public async planByVirtualMetaId(
    virtualMetaId: string,
    signal?: AbortSignal,
  ): Promise<PlannedSeries> {
    const { sourceId } = parseVirtualMetaId(virtualMetaId);
    return this.planBySourceId(sourceId, signal);
  }

  public async planBySourceId(
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<PlannedSeries> {
    const source = await this.requireClient().getSeriesMeta(sourceId, signal);
    const result = groupTvCutEpisodes(
      source.videos.map((episode) => ({
        sourceId: episode.id,
        season: episode.season,
        episode: episode.episode,
        ...(episode.released === undefined
          ? {}
          : { released: episode.released }),
        runtimeSeconds:
          source.runtimeSeconds ?? this.groupingConfig.fallbackRuntimeSeconds,
      })),
      { now: this.now(), config: this.groupingConfig },
    );
    const partBySeason = new Map<number, number>();
    const groups = result.groups.map((group) => {
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
    return {
      source,
      virtualMetaId: createVirtualMetaId(source.id),
      groups,
      warnings: result.warnings,
    };
  }

  public async publicMeta(
    virtualMetaId: string,
    signal?: AbortSignal,
  ): Promise<{ meta: Record<string, unknown> }> {
    const plan = await this.planByVirtualMetaId(virtualMetaId, signal);
    const source = plan.source;
    return {
      meta: {
        id: plan.virtualMetaId,
        type: "series",
        name: `${source.name} — TV Cut`,
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
        videos: plan.groups
          .filter((group) => group.finalized)
          .map((group) => ({
            id: group.virtualVideoId,
            title: `Part ${group.part} (Episodes ${group.firstEpisode}–${group.lastEpisode})`,
            season: group.season,
            episode: group.part,
            ...(group.latestRelease === undefined
              ? {}
              : { released: group.latestRelease }),
          })),
      },
    };
  }

  public async publicStream(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<PublicStreamResponse> {
    if (this.publicBaseUrl === undefined) {
      throw new Error("PUBLIC_BASE_URL is not configured.");
    }
    const cached = this.streamCache.get(virtualVideoId);
    if (
      cached !== undefined &&
      cached.expiresAt > this.now() &&
      this.cutService.isCutActive(cached.cutId)
    ) {
      return cached.response;
    }
    const inFlight = this.streamInFlight.get(virtualVideoId);
    if (inFlight !== undefined) return inFlight;
    const creating = this.createPublicStream(virtualVideoId, signal);
    this.streamInFlight.set(virtualVideoId, creating);
    try {
      return await creating;
    } finally {
      if (this.streamInFlight.get(virtualVideoId) === creating) {
        this.streamInFlight.delete(virtualVideoId);
      }
    }
  }

  private async createPublicStream(
    virtualVideoId: string,
    signal?: AbortSignal,
  ): Promise<PublicStreamResponse> {
    const coordinates = parseVirtualVideoId(virtualVideoId);
    const plan = await this.planBySourceId(coordinates.sourceId, signal);
    const group = plan.groups.find(
      (candidate) =>
        candidate.finalized && candidate.virtualVideoId === virtualVideoId,
    );
    if (group === undefined) {
      throw new InvalidVirtualStremioIdError(
        "Virtual TV Cut is not present in the current finalized grouping plan.",
      );
    }
    const cut = await this.upstreamCutService.createAutomaticCut({
      episodes: group.episodes.map((episode) => ({
        episodeId: episode.sourceId,
        type: "series",
        videoId: episode.sourceId,
      })),
    });
    const response: PublicStreamResponse = {
      streams: [
        {
          name: "AnimeTVCut",
          title: `TV Cut Part ${group.part} · Episodes ${group.firstEpisode}–${group.lastEpisode}`,
          url: new URL(cut.playlistUrl.slice(1), this.publicBaseUrl).toString(),
          behaviorHints: {
            bingeGroup: `animetvcut-tv-${createHash("sha256")
              .update(`${coordinates.sourceId}\0automatic`)
              .digest("base64url")
              .slice(0, 20)}`,
          },
        },
      ],
    };
    if (this.streamCacheTtlMs > 0) {
      this.streamCache.set(virtualVideoId, {
        cutId: cut.cutId,
        response,
        expiresAt: this.now() + this.streamCacheTtlMs,
      });
    }
    return response;
  }

  private requireClient(): MetadataStremioClient {
    if (this.metadataClient === undefined) {
      throw new Error("Metadata Stremio addon is not configured.");
    }
    return this.metadataClient;
  }
}
