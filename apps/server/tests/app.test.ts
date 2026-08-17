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

  it("aligns removals to exact requested boundaries", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // Removal [7, 11) → applied [7, 11) (exact).
    // The composer handles partial segment trimming.
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
        remove: [{ episodeId: "ep1", start: 7, end: 11, type: "opening" }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      duration: number;
      pieces: Array<{ sourceStart: number; sourceEnd: number }>;
      appliedCuts: Array<{
        alignmentPolicy: string;
        status: string;
        appliedStart: number;
        appliedEnd: number;
      }>;
    };
    // Applied range is exact: [7, 11)
    expect(body.appliedCuts[0]).toMatchObject({
      alignmentPolicy: "preserve_content",
      status: "applied",
      appliedStart: 7,
      appliedEnd: 11,
    });
    // Duration = 30 - 4 = 26s (removing [7, 11))
    expect(body.duration).toBe(26);
  });

  it("preserves content when removal aligns with segment boundaries", async () => {
    const app = createApp({ fixtureRoot: path.resolve("fixtures/hls") });
    apps.push(app);
    // Removal [6, 12) → applied [6, 12) (exact).
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
});
