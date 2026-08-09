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

  it("rejects unsupported URL schemes instead of proxying arbitrary URLs", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [{ episodeId: "ep1", playlistUrl: "https://example.test/video.m3u8" }],
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
    expect(expired.json()).toEqual({ error: "Cut session is missing or expired" });
  });
});
