import { randomUUID } from "node:crypto";

import type {
  AppliedCut,
  OutputSkipDiagnostic,
  OutputSkipSegment,
  TimelinePiece,
  VirtualChapter,
} from "@animetvcut/core";
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
  lastAccessedAt: number;
  maxExpiresAt: number;
  expiresAt: number;
  duration: number;
  playlist: string;
  pieces: readonly TimelinePiece[];
  appliedCuts: readonly AppliedCut[];
  resources: ReadonlyMap<string, SessionResource>;
  subtitleTracks: Map<string, SessionSubtitleTrack>;
  subtitleDiagnostics: SubtitleSessionDiagnostics;
  outputSkipSegments: readonly OutputSkipSegment[];
  outputSkipDiagnostics: readonly OutputSkipDiagnostic[];
  chapters?: readonly VirtualChapter[];
  longFormDiagnostics?: {
    mode: "season" | "series";
    families: readonly {
      season: number;
      method: "binge_group" | "filename_family";
      episodeCount: number;
    }[];
    skip: {
      openingRequested: number;
      openingApplied: number;
      endingRequested: number;
      endingApplied: number;
      unsafeSegmentsRetained: number;
    };
  };
}

export interface CutSessionStoreOptions {
  idleTtlMilliseconds?: number;
  maxLifetimeMilliseconds?: number;
  now?: () => number;
}

export class CutSessionStore {
  private readonly sessions = new Map<string, CutSession>();
  private readonly idleTtlMilliseconds: number;
  private readonly maxLifetimeMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: number | CutSessionStoreOptions = {}) {
    const normalized =
      typeof options === "number"
        ? {
            idleTtlMilliseconds: options,
            maxLifetimeMilliseconds: options,
          }
        : options;
    this.idleTtlMilliseconds =
      normalized.idleTtlMilliseconds ?? 6 * 60 * 60 * 1000;
    this.maxLifetimeMilliseconds =
      normalized.maxLifetimeMilliseconds ?? 48 * 60 * 60 * 1000;
    this.now = normalized.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.idleTtlMilliseconds) ||
      this.idleTtlMilliseconds < 0 ||
      !Number.isSafeInteger(this.maxLifetimeMilliseconds) ||
      this.maxLifetimeMilliseconds < this.idleTtlMilliseconds
    )
      throw new Error("Cut session lifetime configuration is invalid.");
  }

  public createId(): string {
    return randomUUID();
  }

  public save(
    session: Omit<
      CutSession,
      "createdAt" | "lastAccessedAt" | "maxExpiresAt" | "expiresAt"
    >,
    now = this.now(),
  ): CutSession {
    this.cleanup(now);
    const maxExpiresAt = now + this.maxLifetimeMilliseconds;
    const complete = {
      ...session,
      createdAt: now,
      lastAccessedAt: now,
      maxExpiresAt,
      expiresAt: Math.min(now + this.idleTtlMilliseconds, maxExpiresAt),
    };
    this.sessions.set(complete.id, complete);
    return complete;
  }

  public get(id: string, now = this.now()): CutSession | undefined {
    const session = this.sessions.get(id);
    if (
      session !== undefined &&
      (session.expiresAt <= now || session.maxExpiresAt <= now)
    ) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  public touch(id: string, now = this.now()): CutSession | undefined {
    const session = this.get(id, now);
    if (session === undefined) return undefined;
    session.lastAccessedAt = now;
    session.expiresAt = Math.min(
      now + this.idleTtlMilliseconds,
      session.maxExpiresAt,
    );
    return session;
  }

  public cleanup(now = this.now()): number {
    let removed = 0;
    for (const id of this.sessions.keys()) {
      if (this.get(id, now) === undefined) removed += 1;
    }
    return removed;
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
