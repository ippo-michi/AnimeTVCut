import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("server foundation and source security", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("reports health", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports MediaFlow as unconfigured without changing basic health", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dev/mediaflow/health",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, reachable: false });
  });

  it("returns a controlled error for an HTTP file without MediaFlow", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [
          {
            kind: "http_file",
            episodeId: "ep1",
            url: "http://fixture-origin/episode1.mkv",
          },
        ],
        remove: [],
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "MediaFlow is not configured." });
  });

  it("rejects unsupported URL schemes instead of proxying arbitrary URLs", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [
          { episodeId: "ep1", playlistUrl: "https://example.test/video.m3u8" },
        ],
        remove: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("fixture://"),
    });
  });

  it("does not resolve resource IDs outside their active cut", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/media/cut/not-a-session/segment/r000001.ts",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns a controlled error after a cut session expires", async () => {
    const app = createApp({
      fixtureRoot: path.resolve("fixtures/hls"),
      sessionTtlMilliseconds: 0,
    });
    apps.push(app);
    const cut = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [],
      },
    });
    expect(cut.statusCode).toBe(200);
    const playlistUrl = (cut.json() as { playlistUrl: string }).playlistUrl;
    const expired = await app.inject({ method: "GET", url: playlistUrl });
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toEqual({
      error: "Cut session is missing or expired",
    });
  });

  it("preserve_content only removes fully-contained segments", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // Removal [7, 11) is NOT fully contained in any segment (6 < 7, 12 > 11).
    // No segments removed. Duration stays 30s.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [{ episodeId: "ep1", start: 7, end: 11, type: "opening" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duration: 30,
      pieces: [{ sourceStart: 0, sourceEnd: 30 }],
      appliedCuts: [
        {
          alignmentPolicy: "preserve_content",
          status: "no_safe_segments",
          reason: "no_complete_segments",
        },
      ],
    });
  });

  it("preserves content when removal aligns with segment boundaries", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // Removal [6, 12) exactly matches segment [6, 12).
    // Fully contained. Removed. Duration = 30 - 6 = 24s.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [{ episodeId: "ep1", start: 6, end: 12, type: "opening" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duration: 24,
      pieces: [
        { sourceStart: 0, sourceEnd: 6 },
        { sourceStart: 12, sourceEnd: 30 },
      ],
      appliedCuts: [
        {
          alignmentPolicy: "preserve_content",
          status: "applied",
          appliedStart: 6,
          appliedEnd: 12,
        },
      ],
    });
  });

  it("strict alignment rejects removals with no fully-contained segments", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // removal(7,11) has no fully-contained segments → no_safe_segments
    // strictAlignment throws on no_safe_segments
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [{ episodeId: "ep1", start: 7, end: 11, type: "opening" }],
        strictAlignment: true,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("strict alignment accepts removals that align with segments", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // removal(6,12) exactly matches segment [6,12) → fully contained → applied
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [{ episodeId: "ep1", start: 6, end: 12, type: "opening" }],
        strictAlignment: true,
      },
    });
    expect(response.statusCode).toBe(200);
  });
});
