import type { Readable } from "node:stream";

import type { CutSession, SessionResource } from "./cut-session-store.js";

interface PrefetchTask {
  controller: AbortController;
  completion: Promise<void>;
}

/** Speculative work shares one bounded budget across all players and seeks. */
export class MediaPrefetcher {
  private readonly inFlight = new Map<SessionResource, PrefetchTask>();
  private readonly completed = new WeakSet<SessionResource>();
  private readonly primed = new WeakSet<CutSession>();
  private closed = false;

  public constructor(private readonly limit: number) {}

  public prime(session: CutSession): void {
    if (this.closed || this.limit === 0 || this.primed.has(session)) return;
    this.primed.add(session);
    let remaining = this.limit;
    for (const resource of session.resources.values()) {
      this.begin(resource);
      if (--remaining === 0) return;
    }
  }

  public after(session: CutSession, current: SessionResource): void {
    if (this.closed || this.limit === 0) return;
    let foundCurrent = false;
    let remaining = this.limit;
    for (const resource of session.resources.values()) {
      if (!foundCurrent) {
        foundCurrent = resource === current;
        continue;
      }
      this.begin(resource);
      if (--remaining === 0) return;
    }
  }

  public async wait(
    resource: SessionResource,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const task = this.inFlight.get(resource);
    if (task === undefined) return;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        task.completion,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("Media request cancelled."));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  public close(): void {
    this.closed = true;
    for (const task of this.inFlight.values()) task.controller.abort();
  }

  private begin(resource: SessionResource): void {
    if (
      this.completed.has(resource) ||
      this.inFlight.has(resource) ||
      this.inFlight.size >= this.limit
    )
      return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    timeout.unref();
    const completion = Promise.resolve().then(async () => {
      let stream: Readable | undefined;
      const cancel = () =>
        stream?.destroy(new Error("Media prefetch cancelled."));
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        controller.signal.throwIfAborted();
        const opened = await resource.open(undefined, controller.signal);
        stream = opened.stream;
        controller.signal.throwIfAborted();
        for await (const chunk of stream) {
          void chunk;
          // Drain to warm MediaFlow's cache without retaining video in Node.
        }
        this.completed.add(resource);
      } catch {
        // Player requests remain authoritative when speculative work fails.
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", cancel);
        stream?.destroy();
        this.inFlight.delete(resource);
      }
    });
    this.inFlight.set(resource, { controller, completion });
  }
}
