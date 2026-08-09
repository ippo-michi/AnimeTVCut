import {
  buildTimeline,
  subtractRemovedRanges,
  type AppliedCut,
  type RemovedRange,
  type SourceRange,
  type TimelinePiece,
} from "@animetvcut/core";
import { alignRemovedRanges, composeHlsVod, type CompositionSource } from "@animetvcut/hls";

import { CutSessionStore, type SessionResource } from "./cut-session-store.js";
import { FixtureSourceLoader } from "./fixture-source.js";

export interface DevCutRequest {
  sources: Array<{ episodeId: string; playlistUrl: string }>;
  remove: RemovedRange[];
}

export interface DevCutResponse {
  cutId: string;
  duration: number;
  playlistUrl: string;
  pieces: TimelinePiece[];
  appliedCuts: AppliedCut[];
}

export class CutService {
  public constructor(
    private readonly fixtureLoader: FixtureSourceLoader,
    private readonly sessions: CutSessionStore,
  ) {}

  public async createCut(request: DevCutRequest): Promise<DevCutResponse> {
    const episodeIds = new Set<string>();
    for (const source of request.sources) {
      if (episodeIds.has(source.episodeId)) {
        throw new Error(`Duplicate episode ID: ${source.episodeId}`);
      }
      episodeIds.add(source.episodeId);
    }
    for (const removal of request.remove) {
      if (!episodeIds.has(removal.episodeId)) {
        throw new Error(`Removal references unknown episode: ${removal.episodeId}`);
      }
    }

    const compositionSources: CompositionSource[] = [];
    const retainedRanges: SourceRange[] = [];
    const allAppliedCuts: AppliedCut[] = [];

    for (const source of request.sources) {
      const playlist = await this.fixtureLoader.loadPlaylist(source.playlistUrl);
      compositionSources.push({ episodeId: source.episodeId, playlist });
      const requested = request.remove.filter(
        (removal) => removal.episodeId === source.episodeId,
      );
      const appliedCuts = alignRemovedRanges(playlist, requested);
      allAppliedCuts.push(...appliedCuts);
      const appliedRemovals: RemovedRange[] = appliedCuts.map((cut) => ({
        episodeId: cut.episodeId,
        start: cut.appliedStart,
        end: cut.appliedEnd,
        type: cut.type,
      }));
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
    for (const resource of composed.resources) {
      const fixture = await this.fixtureLoader.resolveResource(resource.absoluteUri);
      resources.set(resource.id, {
        id: resource.id,
        localPath: fixture.localPath,
        size: fixture.size,
        contentType: resource.contentType,
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
