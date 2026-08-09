import { randomUUID } from "node:crypto";

import type { AppliedCut, TimelinePiece } from "@animetvcut/core";

export interface SessionResource {
  id: string;
  localPath: string;
  size: number;
  contentType: string;
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
}
