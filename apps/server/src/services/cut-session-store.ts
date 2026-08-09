import { randomUUID } from "node:crypto";

import type { AppliedCut, TimelinePiece } from "@animetvcut/core";
import type {
  SubtitleFamilyMethod,
  SubtitleOutputFormat,
  SubtitleSourceFormat,
} from "@animetvcut/subtitles";

import type { LazyMediaResource } from "./hls-source-loader.js";

export interface SessionResource extends LazyMediaResource {
  id: string;
}

export interface SessionSubtitleSource {
  episodeId: string;
  subtitleId: string;
  url: string;
  formatHint?: SubtitleSourceFormat;
}
export interface SessionSubtitleTrack {
  id: string;
  lang: string;
  familyMethod: SubtitleFamilyMethod;
  outputFormat: SubtitleOutputFormat;
  sources: readonly SessionSubtitleSource[];
  state: "lazy" | "composing" | "ready" | "failed";
  cueCount?: number;
  errorCode?: string;
  cached?: Uint8Array;
  inFlight?: Promise<Uint8Array>;
  abortController?: AbortController;
  waiters?: number;
}
export interface SubtitleSessionDiagnostics {
  discoveredPerEpisode: Readonly<Record<string, number>>;
  issues: readonly { lang: string; reason: string }[];
}

export interface CutSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  duration: number;
  playlist: string;
  pieces: readonly TimelinePiece[];
  appliedCuts: readonly AppliedCut[];
  resources: ReadonlyMap<string, SessionResource>;
  subtitleTracks: Map<string, SessionSubtitleTrack>;
  subtitleDiagnostics: SubtitleSessionDiagnostics;
}

export class CutSessionStore {
  private readonly sessions = new Map<string, CutSession>();

  public constructor(private readonly ttlMilliseconds = 60 * 60 * 1000) {}

  public createId(): string {
    return randomUUID();
  }

  public save(
    session: Omit<CutSession, "createdAt" | "expiresAt">,
    now = Date.now(),
  ): CutSession {
    const complete = {
      ...session,
      createdAt: now,
      expiresAt: now + this.ttlMilliseconds,
    };
    this.sessions.set(complete.id, complete);
    return complete;
  }

  public get(id: string, now = Date.now()): CutSession | undefined {
    const session = this.sessions.get(id);
    if (session !== undefined && session.expiresAt <= now) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  public attachSubtitles(
    id: string,
    tracks: readonly SessionSubtitleTrack[],
    diagnostics: SubtitleSessionDiagnostics,
  ): void {
    const session = this.get(id);
    if (session === undefined) return;
    session.subtitleTracks.clear();
    for (const track of tracks) session.subtitleTracks.set(track.id, track);
    session.subtitleDiagnostics = diagnostics;
  }
}
