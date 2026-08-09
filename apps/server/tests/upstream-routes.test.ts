import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { EpisodeSourceResolver } from "../src/services/stremio-upstream/types.js";

const resolver: EpisodeSourceResolver = {
  resolve: async (episodes) => ({
    familyMethod: "binge_group",
    familyKey: "internal-family-key",
    episodes: episodes.map((episode, rank) => ({
      episodeId: episode.episodeId,
      upstreamType: episode.type,
      upstreamVideoId: episode.videoId,
      upstreamRank: rank,
      familyMethod: "binge_group",
      familyKey: "internal-family-key",
      filename: `Show - 0${rank + 1}.mkv`,
      mediaSource: {
        kind: "http_media",
        episodeId: episode.episodeId,
        url: `https://signed-source.test/episode${rank + 1}?token=secret`,
        headers: { Authorization: "Bearer secret", Cookie: "private=true" },
      },
    })),
    unsupported: {
      torrent: 4,
      usenet: 1,
      archive: 1,
      youtube: 0,
      external: 0,
      unsupported: 1,
    },
    warnings: [],
  }),
};

describe("sanitized upstream development routes", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("returns a sanitized family resolution", async () => {
    const app = createApp({ episodeSourceResolver: resolver });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/upstream/resolve",
      payload: {
        episodes: [
          {
            episodeId: "ep1",
            type: "series",
            videoId: "tt1234567:1:1",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      familyMethod: "binge_group",
      episodes: [
        {
          episodeId: "ep1",
          rank: 0,
          filename: "Show - 01.mkv",
          candidateKind: "url",
        },
      ],
      unsupported: { torrent: 4, usenet: 1, other: 2 },
      warnings: [],
    });
    expect(response.body).not.toMatch(
      /signed-source|token|Authorization|Bearer|Cookie|internal-family-key/,
    );
  });

  it("reports unconfigured upstream without exposing configuration", async () => {
    const app = createApp();
    apps.push(app);
    const health = await app.inject({
      method: "GET",
      url: "/api/v1/dev/upstream/health",
    });
    expect(health.json()).toEqual({
      configured: false,
      reachable: false,
      manifestValid: false,
    });
    const resolve = await app.inject({
      method: "POST",
      url: "/api/v1/dev/upstream/resolve",
      payload: {
        episodes: [{ episodeId: "ep1", type: "series", videoId: "id:1" }],
      },
    });
    expect(resolve.statusCode).toBe(503);
    expect(resolve.json()).toEqual({
      error: "Upstream Stremio addon is not configured.",
    });
  });
});
