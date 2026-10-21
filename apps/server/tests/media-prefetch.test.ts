import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CutSessionStore } from "../src/services/cut-session-store.js";
import type { SessionResource } from "../src/services/cut-session-store.js";
import { MediaPrefetcher } from "../src/services/media-prefetch.js";

function resource(
  id: string,
  stream: Readable = new PassThrough(),
): SessionResource {
  return {
    id,
    kind: "segment",
    sourceEpisodeId: "ep1",
    completesSourceEpisode: false,
    contentType: "video/mp2t",
    open: vi.fn(async () => ({
      statusCode: 200 as const,
      contentType: "video/mp2t",
      responseHeaders: {},
      stream,
    })),
  };
}

function session(resources: SessionResource[]) {
  return new CutSessionStore().save({
    id: "test",
    duration: 6,
    playlist: "",
    pieces: [],
    appliedCuts: [],
    resources: new Map(resources.map((item) => [item.id, item])),
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
    outputSkipSegments: [],
    outputSkipDiagnostics: [],
  });
}

describe("bounded media prefetch", () => {
  const workers: MediaPrefetcher[] = [];
  afterEach(() => workers.splice(0).forEach((worker) => worker.close()));

  function worker(limit = 2) {
    const value = new MediaPrefetcher(limit);
    workers.push(value);
    return value;
  }

  it("shares its concurrency budget across players and seeks", async () => {
    const resources = Array.from({ length: 8 }, (_, i) => resource(String(i)));
    const cut = session(resources);
    const prefetch = worker();
    prefetch.after(cut, resources[0]!);
    prefetch.after(cut, resources[4]!);
    const other = [resource("other"), resource("next")];
    prefetch.after(session(other), other[0]!);
    await vi.waitFor(() => expect(resources[1]!.open).toHaveBeenCalledOnce());
    expect(resources[2]!.open).toHaveBeenCalledOnce();
    expect(resources[5]!.open).not.toHaveBeenCalled();
    expect(resources[6]!.open).not.toHaveBeenCalled();
    expect(other[1]!.open).not.toHaveBeenCalled();
  });

  it("lets a disconnected player stop waiting without cancelling shared work", async () => {
    const resources = [resource("current"), resource("next")];
    const prefetch = worker(1);
    prefetch.after(session(resources), resources[0]!);
    await vi.waitFor(() => expect(resources[1]!.open).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const cancelled = prefetch.wait(resources[1]!, controller.signal);
    const waiting = prefetch.wait(resources[1]!, new AbortController().signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    const opened = await vi.mocked(resources[1]!.open).mock.results[0]!.value;
    expect(opened.stream.destroyed).toBe(false);
    (opened.stream as PassThrough).end("media");
    await waiting;
  });

  it("cancels background streams on shutdown and starts no new work", async () => {
    const stream = new PassThrough();
    const resources = [
      resource("current"),
      resource("next", stream),
      resource("last"),
    ];
    const prefetch = worker(1);
    prefetch.after(session(resources), resources[0]!);
    await vi.waitFor(() => expect(resources[1]!.open).toHaveBeenCalledOnce());
    prefetch.close();
    expect(stream.destroyed).toBe(true);
    await prefetch.wait(resources[1]!, new AbortController().signal);
    prefetch.after(session(resources), resources[1]!);
    expect(resources[2]!.open).not.toHaveBeenCalled();
  });

  it("frees a failed slot so later requests can warm another segment", async () => {
    const failed = resource("failed");
    vi.mocked(failed.open).mockImplementation(() => {
      throw new Error("failed");
    });
    const resources = [
      resource("current"),
      failed,
      resource("next", Readable.from("media")),
    ];
    const prefetch = worker(1);
    const cut = session(resources);
    prefetch.after(cut, resources[0]!);
    await prefetch.wait(failed, new AbortController().signal);
    prefetch.after(cut, failed);
    await vi.waitFor(() => expect(resources[2]!.open).toHaveBeenCalledOnce());
  });
});
