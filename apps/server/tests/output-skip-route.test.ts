import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { mediaRoutes } from "../src/routes/media.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";

function save(store: CutSessionStore) {
  return store.save({
    id: "cut",
    duration: 10,
    playlist: "#EXTM3U",
    pieces: [],
    appliedCuts: [],
    resources: new Map(),
    subtitleTracks: new Map(),
    subtitleDiagnostics: { discoveredPerEpisode: {}, issues: [] },
    outputSkipSegments: [
      {
        id: "s01",
        type: "intro",
        start: 0,
        end: 2,
        title: "Skip Intro",
        reason: "policy_kept",
      },
    ],
    outputSkipDiagnostics: [
      {
        sourceIndex: 0,
        type: "intro",
        decision: "keep",
        sourceStart: 0,
        sourceEnd: 2,
        removalRequested: false,
        status: "mapped",
        retainedFragments: 1,
        outputRanges: [{ start: 0, end: 2 }],
        reason: "policy_kept",
      },
    ],
  });
}

describe("output skip routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it("serves immutable public output coordinates with scoped CORS and touches activity", async () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 1_000,
      maxLifetimeMilliseconds: 10_000,
      now: () => now,
    });
    save(store);
    const app = Fastify();
    apps.push(app);
    await app.register(mediaRoutes(store));
    now = 900;
    const response = await app.inject({
      method: "GET",
      url: "/media/cut/cut/segments.json",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toEqual({
      version: 1,
      duration: 10,
      segments: [expect.objectContaining({ id: "s01", start: 0, end: 2 })],
    });
    now = 1_500;
    expect(store.get("cut")).toBeDefined();
  });

  it("does not touch invalid access and keeps development output sanitized", async () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 1_000,
      maxLifetimeMilliseconds: 10_000,
      now: () => now,
    });
    save(store);
    const app = Fastify();
    apps.push(app);
    await app.register(mediaRoutes(store));
    now = 900;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/media/cut/unknown/segments.json",
        })
      ).statusCode,
    ).toBe(404);
    const diagnostic = await app.inject({
      method: "GET",
      url: "/api/v1/dev/cuts/cut/segments",
    });
    expect(diagnostic.body).not.toMatch(/https?:|provider|episodeId|token/i);
    now = 1_001;
    expect(store.get("cut")).toBeUndefined();
  });

  it("supports public preflight without exposing private API CORS", async () => {
    const store = new CutSessionStore();
    save(store);
    const app = Fastify();
    apps.push(app);
    await app.register(mediaRoutes(store));
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/media/cut/cut/segments.json",
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    const dev = await app.inject({
      method: "GET",
      url: "/api/v1/dev/cuts/cut/segments",
    });
    expect(dev.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never extends the absolute session lifetime", async () => {
    let now = 0;
    const store = new CutSessionStore({
      idleTtlMilliseconds: 800,
      maxLifetimeMilliseconds: 1_000,
      now: () => now,
    });
    save(store);
    const app = Fastify();
    apps.push(app);
    await app.register(mediaRoutes(store));
    now = 700;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/media/cut/cut/segments.json",
        })
      ).statusCode,
    ).toBe(200);
    now = 1_000;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/media/cut/cut/segments.json",
        })
      ).statusCode,
    ).toBe(404);
  });
});
