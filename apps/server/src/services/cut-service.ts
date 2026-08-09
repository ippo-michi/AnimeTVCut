import {
  buildTimeline,
  subtractRemovedRanges,
  type AppliedCut,
  type CutAlignmentPolicy,
  type RemovedRange,
  type SourceRange,
  type TimelinePiece,
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
    const resources = new Map<string, SessionResource>();
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
    });

    return {
      cutId,
      duration: composed.duration,
      playlistUrl: `/media/cut/${cutId}/master.m3u8`,
      pieces,
      appliedCuts: allAppliedCuts,
    };
  }
}
