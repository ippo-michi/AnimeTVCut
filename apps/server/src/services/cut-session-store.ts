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
import type { HlsResourceKind } from "@animetvcut/hls";

import type {
  HttpMediaSource,
  HlsResolvedResource,
  LazyMediaResource,
} from "./hls-source-loader.js";
import type { SessionPersistence } from "./session-persistence.js";
import type { sanitizeSkipResolution } from "./skip-service.js";

export interface SessionResource extends LazyMediaResource {
  resolved?: HlsResolvedResource;
  id: string;
  kind: HlsResourceKind;
  sourceEpisodeId: string;
  completesSourceEpisode: boolean;
}

export interface WatchProgressSessionState {
  eligibleSourceEpisodeIds: ReadonlySet<string>;
  triggeredSourceEpisodeIds: Set<string>;
  inFlightSourceEpisodeIds: Set<string>;
  unavailable: boolean;
}

export interface SessionSubtitleSource {
  episodeId: string;
  subtitleId: string;
  url: string;
  formatHint?: SubtitleSourceFormat;
  embedded?: {
    source: HttpMediaSource;
    streamIndex: number;
    format: SubtitleSourceFormat;
  };
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
  skipDiagnostics?: {
    episodes: readonly ReturnType<typeof sanitizeSkipResolution>[];
    warnings: readonly string[];
  };
  watchProgress?: WatchProgressSessionState;
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
  persistence?: SessionPersistence;
  maxSessions?: number;
  maxMemoryBytes?: number;
  idleTtlMilliseconds?: number;
  maxLifetimeMilliseconds?: number;
  now?: () => number;
}

export class SessionCapacityError extends Error {
  public constructor() {
    super(
      "Cut session capacity is exhausted. Retry after an active cut expires.",
    );
  }
}

function estimatedBytes(session: CutSession): number {
  const sources = new Set(
    [...session.resources.values()].map(
      (resource) => resource.resolved?.source,
    ),
  );
  return (
    2048 +
    Buffer.byteLength(session.playlist) * 2 +
    [...session.resources.values()].reduce(
      (size, resource) =>
        size + 512 + (resource.resolved?.resource.absoluteUri.length ?? 0) * 2,
      0,
    ) +
    session.pieces.length * 256 +
    session.outputSkipDiagnostics.length * 256 +
    [...sources].reduce(
      (size, source) =>
        size +
        (source?.kind === "http_media"
          ? source.url.length * 2 +
            JSON.stringify(source.headers ?? {}).length * 2 +
            (source.recovery?.playlist?.segments.reduce(
              (size, segment) =>
                size +
                512 +
                segment.absoluteUri.length * 2 +
                (segment.map?.absoluteUri.length ?? 0) * 2,
              0,
            ) ?? 0)
          : 0),
      0,
    ) +
    [...session.subtitleTracks.values()].reduce(
      (size, track) =>
        size +
        (track.cached?.byteLength ?? 0) +
        track.sources.reduce(
          (size, source) =>
            size +
            source.url.length * 2 +
            (source.embedded === undefined
              ? 0
              : JSON.stringify(source.embedded).length * 2) +
            256,
          0,
        ),
      0,
    )
  );
}

export class CutSessionStore {
  private readonly sessions = new Map<string, CutSession>();
  private readonly idleTtlMilliseconds: number;
  private readonly maxLifetimeMilliseconds: number;
  private readonly now: () => number;
  private readonly persistence?: SessionPersistence;
  private readonly persistedAt = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly maxMemoryBytes: number;
  private persistenceFailures = 0;

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
    this.persistence = normalized.persistence;
    this.maxSessions = normalized.maxSessions ?? 128;
    this.maxMemoryBytes = normalized.maxMemoryBytes ?? 256 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      !Number.isSafeInteger(this.maxMemoryBytes) ||
      this.maxMemoryBytes < 1
    )
      throw new Error("Cut session capacity configuration is invalid.");
    if (
      !Number.isSafeInteger(this.idleTtlMilliseconds) ||
      this.idleTtlMilliseconds < 0 ||
      !Number.isSafeInteger(this.maxLifetimeMilliseconds) ||
      this.maxLifetimeMilliseconds < this.idleTtlMilliseconds
    )
      throw new Error("Cut session lifetime configuration is invalid.");
    for (const session of this.persistence?.restore(
      this.now(),
      this.maxSessions,
      this.maxMemoryBytes,
    ) ?? []) {
      if (
        this.stats().estimatedBytes + estimatedBytes(session) <=
        this.maxMemoryBytes
      )
        this.sessions.set(session.id, session);
      else this.persistence?.delete(session.id);
    }
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
    if (
      (!this.sessions.has(complete.id) &&
        this.sessions.size >= this.maxSessions) ||
      this.stats().estimatedBytes + estimatedBytes(complete) >
        this.maxMemoryBytes
    )
      throw new SessionCapacityError();
    this.sessions.set(complete.id, complete);
    try {
      this.checkpoint(complete.id, true);
    } catch (error) {
      this.sessions.delete(complete.id);
      throw error;
    }
    return complete;
  }

  public get(id: string, now = this.now()): CutSession | undefined {
    const session = this.sessions.get(id);
    if (
      session !== undefined &&
      (session.expiresAt <= now || session.maxExpiresAt <= now)
    ) {
      this.sessions.delete(id);
      for (const track of session.subtitleTracks.values())
        track.abortController?.abort();
      this.persistedAt.delete(id);
      try {
        this.persistence?.delete(id);
      } catch {
        this.persistenceFailures += 1;
      }
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
    if (now - (this.persistedAt.get(id) ?? 0) >= 30_000) this.checkpoint(id);
    return session;
  }

  public checkpoint(id: string, required = false): void {
    const session = this.sessions.get(id);
    if (session === undefined || this.persistence === undefined) return;
    try {
      this.persistence.save(session);
      this.persistedAt.set(id, this.now());
    } catch (error) {
      this.persistenceFailures += 1;
      if (required) throw error;
    }
  }

  public checkpointAll(): void {
    for (const id of this.sessions.keys()) this.checkpoint(id);
  }

  public cacheSubtitle(track: SessionSubtitleTrack, bytes: Uint8Array): void {
    if (this.stats().estimatedBytes + bytes.byteLength <= this.maxMemoryBytes)
      track.cached = bytes;
  }

  public stats() {
    let bytes = 0,
      resources = 0,
      subtitleBytes = 0;
    for (const session of this.sessions.values()) {
      bytes += estimatedBytes(session);
      resources += session.resources.size;
      for (const track of session.subtitleTracks.values())
        subtitleBytes += track.cached?.byteLength ?? 0;
    }
    return {
      active: this.sessions.size,
      limit: this.maxSessions,
      resources,
      estimatedBytes: bytes,
      maxMemoryBytes: this.maxMemoryBytes,
      subtitleBytes,
      persistenceEnabled: this.persistence !== undefined,
      persistenceFailures: this.persistenceFailures,
      rejectedSnapshots: this.persistence?.rejectedSnapshots ?? 0,
    };
  }

  public close(): void {
    this.cleanup();
    this.checkpointAll();
    for (const session of this.sessions.values())
      for (const track of session.subtitleTracks.values())
        track.abortController?.abort();
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
    this.checkpoint(id);
  }
}
