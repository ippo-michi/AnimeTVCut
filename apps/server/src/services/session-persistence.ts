import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ComposedResource } from "@animetvcut/hls";

import type {
  CutSession,
  SessionResource,
  SessionSubtitleTrack,
} from "./cut-session-store.js";
import type { HlsSourceLoader, MediaInputSource } from "./hls-source-loader.js";

type StoredResource = Omit<SessionResource, "open" | "resolved"> & {
  sourceIndex: number;
  descriptor: ComposedResource;
};
interface StoredSession {
  version: 1;
  session: Omit<CutSession, "resources" | "subtitleTracks" | "watchProgress">;
  sources: MediaInputSource[];
  resources: StoredResource[];
  subtitles: Omit<
    SessionSubtitleTrack,
    "cached" | "inFlight" | "abortController" | "waiters"
  >[];
  watchProgress?: {
    eligible: string[];
    triggered: string[];
    unavailable: boolean;
  };
}

function checksum(value: StoredSession): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Private, atomic snapshots. Functions and transient work are rebuilt, never serialized. */
export class SessionPersistence {
  public rejectedSnapshots = 0;

  public constructor(
    private readonly directory: string,
    private readonly loader: HlsSourceLoader,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new Error("Invalid persisted cut identifier.");
    return path.join(this.directory, `${id}.json`);
  }

  public save(session: CutSession): void {
    const { resources, subtitleTracks, watchProgress, ...data } = session;
    const sources: MediaInputSource[] = [];
    const stored: StoredSession = {
      version: 1,
      session: data,
      sources,
      resources: [...resources.values()].map(
        ({
          resolved,
          id,
          kind,
          sourceEpisodeId,
          completesSourceEpisode,
          contentType,
        }) => {
          if (resolved === undefined)
            throw new Error("Cut resource has no recovery descriptor.");
          let sourceIndex = sources.indexOf(resolved.source);
          if (sourceIndex < 0) {
            sourceIndex = sources.length;
            sources.push(resolved.source);
          }
          return {
            id,
            kind,
            sourceEpisodeId,
            completesSourceEpisode,
            contentType,
            sourceIndex,
            descriptor: resolved.resource,
          };
        },
      ),
      subtitles: [...subtitleTracks.values()].map(
        ({ id, lang, familyMethod, outputFormat, sources }) => ({
          id,
          lang,
          familyMethod,
          outputFormat,
          sources,
          state: "lazy",
        }),
      ),
      ...(watchProgress === undefined
        ? {}
        : {
            watchProgress: {
              eligible: [...watchProgress.eligibleSourceEpisodeIds],
              triggered: [...watchProgress.triggeredSourceEpisodeIds],
              unavailable: watchProgress.unavailable,
            },
          }),
    };
    const bytes = JSON.stringify({ ...stored, checksum: checksum(stored) });
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024)
      throw new Error("Cut recovery snapshot exceeds its size limit.");
    const file = this.file(session.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
      renameSync(temporary, file);
    } catch {
      rmSync(temporary, { force: true });
      throw new Error("Cut recovery snapshot could not be saved.");
    }
  }

  public restore(
    now: number,
    maximumSessions = 128,
    maximumBytes = 256 * 1024 * 1024,
  ): CutSession[] {
    const sessions: CutSession[] = [];
    let bytes = 0;
    const entries = readdirSync(this.directory);
    for (const entry of entries)
      if (/^[A-Za-z0-9_-]{1,128}\.json\.[a-f0-9-]{36}\.tmp$/.test(entry))
        rmSync(path.join(this.directory, entry), { force: true });
    const names = entries
      .filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name))
      .sort(
        (a, b) =>
          statSync(path.join(this.directory, b)).mtimeMs -
          statSync(path.join(this.directory, a)).mtimeMs,
      );
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      try {
        const size = statSync(file).size;
        if (
          size > 64 * 1024 * 1024 ||
          bytes + size > maximumBytes ||
          sessions.length >= maximumSessions
        )
          throw new Error("Snapshot capacity exceeded");
        const { checksum: expected, ...stored } = JSON.parse(
          readFileSync(file, "utf8"),
        ) as StoredSession & { checksum: string };
        if (expected !== checksum(stored))
          throw new Error("Snapshot checksum mismatch");
        const data = stored.session;
        if (
          stored.version !== 1 ||
          data.id !== name.slice(0, -5) ||
          !Number.isFinite(data.expiresAt) ||
          !Number.isFinite(data.maxExpiresAt) ||
          !Array.isArray(stored.sources) ||
          stored.sources.length > 128 ||
          !Array.isArray(stored.resources) ||
          stored.resources.length > 40_128 ||
          !Array.isArray(stored.subtitles) ||
          typeof data.playlist !== "string" ||
          !Array.isArray(data.pieces) ||
          !Array.isArray(data.appliedCuts) ||
          !Array.isArray(data.outputSkipSegments) ||
          !Array.isArray(data.outputSkipDiagnostics) ||
          !Number.isFinite(data.duration)
        )
          throw new Error("Invalid snapshot");
        if (data.expiresAt <= now || data.maxExpiresAt <= now) {
          rmSync(file);
          continue;
        }
        const resources = new Map<string, SessionResource>();
        for (const {
          sourceIndex,
          descriptor,
          ...resource
        } of stored.resources) {
          const source = stored.sources[sourceIndex];
          if (source === undefined || descriptor.id !== resource.id)
            throw new Error("Invalid resource descriptor");
          const resolved = { source, resource: descriptor };
          resources.set(resource.id, {
            ...resource,
            resolved,
            ...this.loader.createResource(resolved),
          });
        }
        sessions.push({
          ...data,
          resources,
          subtitleTracks: new Map(
            stored.subtitles.map((track) => [
              track.id,
              { ...track, state: "lazy" },
            ]),
          ),
          ...(stored.watchProgress === undefined
            ? {}
            : {
                watchProgress: {
                  eligibleSourceEpisodeIds: new Set(
                    stored.watchProgress.eligible,
                  ),
                  triggeredSourceEpisodeIds: new Set(
                    stored.watchProgress.triggered,
                  ),
                  inFlightSourceEpisodeIds: new Set<string>(),
                  unavailable: stored.watchProgress.unavailable,
                },
              }),
        });
        bytes += size;
      } catch {
        this.rejectedSnapshots += 1;
        rmSync(file, { force: true });
      }
    }
    return sessions;
  }

  public delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}
