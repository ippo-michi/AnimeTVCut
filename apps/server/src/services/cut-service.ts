import {
  buildTimeline,
  mapOutputSkipSegments,
  subtractRemovedRanges,
  type AppliedCut,
  type CutAlignmentPolicy,
  type RemovedRange,
  type SourceRange,
  type SafeSourceSkipSegment,
  type TimelinePiece,
  type VirtualChapter,
} from "@animetvcut/core";
import {
  alignRemovedRanges,
  composeHlsVod,
  type CompositionSource,
  type HlsVodPlaylist,
} from "@animetvcut/hls";

import type { CutSessionStore, SessionResource } from "./cut-session-store.js";
import type { HlsSourceLoader, MediaInputSource } from "./hls-source-loader.js";

export interface DevCutRequest {
  sources: MediaInputSource[];
  remove: RemovedRange[];
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
}

export interface DevCutResponse {
  cutId: string;
  duration: number;
  playlistUrl: string;
  pieces: TimelinePiece[];
  appliedCuts: AppliedCut[];
}

export interface PreparedInputSource {
  source: MediaInputSource;
  playlist: HlsVodPlaylist;
}

export interface PreparedCutRequest {
  sources: readonly PreparedInputSource[];
  remove: RemovedRange[];
  alignmentPolicy?: CutAlignmentPolicy;
  strictAlignment?: boolean;
  chapterEpisodes?: readonly ChapterEpisodeInput[];
  maxMediaSegments?: number;
  maxManifestBytes?: number;
}

export interface ChapterEpisodeInput {
  sourceEpisodeId: string;
  season: number;
  episode: number;
  title?: string;
}

export class CutService {
  public constructor(
    private readonly sourceLoader: HlsSourceLoader,
    private readonly sessions: CutSessionStore,
  ) {}

  public async createCut(request: DevCutRequest): Promise<DevCutResponse> {
    const sources = await this.prepareSources(request.sources);
    return this.createCutFromPreparedSources({ ...request, sources });
  }

  public isCutActive(cutId: string): boolean {
    return this.sessions.get(cutId) !== undefined;
  }

  public session(cutId: string) {
    return this.sessions.get(cutId);
  }

  public enableWatchProgress(
    cutId: string,
    sourceEpisodeIds: readonly string[],
  ): void {
    const session = this.sessions.get(cutId);
    if (session === undefined) return;
    const available = new Set(
      session.pieces.map((piece) => piece.sourceEpisodeId),
    );
    const eligible = new Set(sourceEpisodeIds);
    if (
      eligible.size === 0 ||
      [...eligible].some((episodeId) => !available.has(episodeId))
    )
      throw new Error(
        "Watch-progress episodes do not match the composed cut timeline.",
      );
    session.watchProgress = {
      eligibleSourceEpisodeIds: eligible,
      triggeredSourceEpisodeIds: new Set(),
      inFlightSourceEpisodeIds: new Set(),
      unavailable: false,
    };
  }

  public attachOutputSkipSegments(
    cutId: string,
    sourceSegments: readonly SafeSourceSkipSegment[],
  ): void {
    const session = this.sessions.get(cutId);
    if (session === undefined) return;
    const mapped = mapOutputSkipSegments(session.pieces, sourceSegments);
    session.outputSkipSegments = mapped.segments;
    session.outputSkipDiagnostics = mapped.diagnostics;
  }

  public async prepareSources(
    sources: readonly MediaInputSource[],
  ): Promise<PreparedInputSource[]> {
    const episodeIds = new Set<string>();
    const prepared: PreparedInputSource[] = [];
    for (const source of sources) {
      if (episodeIds.has(source.episodeId)) {
        throw new Error(`Duplicate episode ID: ${source.episodeId}`);
      }
      episodeIds.add(source.episodeId);
      prepared.push({
        source,
        playlist: await this.sourceLoader.loadPlaylist(source),
      });
    }
    return prepared;
  }

  public createCutFromPreparedSources(
    request: PreparedCutRequest,
  ): DevCutResponse {
    const episodeIds = new Set(
      request.sources.map(({ source }) => source.episodeId),
    );
    for (const removal of request.remove) {
      if (!episodeIds.has(removal.episodeId)) {
        throw new Error(
          `Removal references unknown episode: ${removal.episodeId}`,
        );
      }
    }

    const compositionSources: CompositionSource[] = [];
    const retainedRanges: SourceRange[] = [];
    const allAppliedCuts: AppliedCut[] = [];

    for (const { source, playlist } of request.sources) {
      compositionSources.push({ episodeId: source.episodeId, playlist });
      const requested = request.remove.filter(
        (removal) => removal.episodeId === source.episodeId,
      );
      // AnimeTVCut owns the retained timeline and alignment policy. Source loaders may
      // later proxy or normalize media, but never decide which normalized segments remain.
      const appliedCuts = alignRemovedRanges(playlist, requested, {
        policy: request.alignmentPolicy ?? "preserve_content",
        strict: request.strictAlignment ?? false,
      });
      allAppliedCuts.push(...appliedCuts);
      const appliedRemovals: RemovedRange[] = appliedCuts.flatMap((cut) =>
        cut.status === "applied"
          ? [
              {
                episodeId: cut.episodeId,
                start: cut.appliedStart,
                end: cut.appliedEnd,
                type: cut.type,
              },
            ]
          : [],
      );
      retainedRanges.push(
        ...subtractRemovedRanges(
          {
            sourceEpisodeId: source.episodeId,
            sourceStart: 0,
            sourceEnd: playlist.duration,
            kind: "content",
          },
          appliedRemovals,
        ),
      );
    }

    const pieces = buildTimeline(retainedRanges);
    const cutId = this.sessions.createId();
    const composed = composeHlsVod(cutId, compositionSources, pieces);
    if (
      request.maxMediaSegments !== undefined &&
      composed.segmentCount > request.maxMediaSegments
    )
      throw new Error("Long Cut exceeds the configured media segment limit.");
    if (
      request.maxManifestBytes !== undefined &&
      Buffer.byteLength(composed.text, "utf8") > request.maxManifestBytes
    )
      throw new Error("Long Cut exceeds the configured manifest size limit.");
    const resources = new Map<string, SessionResource>();
    const lastSegmentByEpisode = new Map<string, string>();
    for (const resource of composed.resources) {
      if (resource.kind === "segment")
        lastSegmentByEpisode.set(resource.sourceEpisodeId, resource.id);
    }
    const sourcesByEpisode = new Map(
      request.sources.map(({ source }) => [source.episodeId, source]),
    );
    for (const resource of composed.resources) {
      const source = sourcesByEpisode.get(resource.sourceEpisodeId);
      if (source === undefined) {
        throw new Error(
          `Missing source reference for ${resource.sourceEpisodeId}`,
        );
      }
      const resolved = this.sourceLoader.createResource({ source, resource });
      resources.set(resource.id, {
        id: resource.id,
        kind: resource.kind,
        sourceEpisodeId: resource.sourceEpisodeId,
        completesSourceEpisode:
          resource.kind === "segment" &&
          lastSegmentByEpisode.get(resource.sourceEpisodeId) === resource.id,
        ...resolved,
      });
    }
    this.sessions.save({
      id: cutId,
      duration: composed.duration,
      playlist: composed.text,
      pieces,
      appliedCuts: allAppliedCuts,
      resources,
      subtitleTracks: new Map(),
      subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
      outputSkipSegments: [],
      outputSkipDiagnostics: [],
      chapters: this.buildChapters(pieces, request.chapterEpisodes ?? []),
    });

    return {
      cutId,
      duration: composed.duration,
      playlistUrl: `/media/cut/${cutId}/master.m3u8`,
      pieces,
      appliedCuts: allAppliedCuts,
    };
  }

  private buildChapters(
    pieces: readonly TimelinePiece[],
    episodes: readonly ChapterEpisodeInput[],
  ): VirtualChapter[] {
    const multiSeason =
      new Set(episodes.map((episode) => episode.season)).size > 1;
    return episodes.flatMap((episode) => {
      const first = pieces.find(
        (piece) => piece.sourceEpisodeId === episode.sourceEpisodeId,
      );
      if (first === undefined) return [];
      const coordinate = multiSeason
        ? `S${episode.season}E${episode.episode}`
        : `Episode ${episode.episode}`;
      return [
        {
          title:
            episode.title === undefined || episode.title.trim() === ""
              ? coordinate
              : `${coordinate} — ${episode.title}`,
          start: first.outputStart,
          type: "episode" as const,
          sourceEpisodeId: episode.sourceEpisodeId,
        },
      ];
    });
  }
}
