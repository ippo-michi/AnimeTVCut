import path from "node:path";

import {
  type SkipProviderResult,
  type SkipSegmentProvider,
} from "@animetvcut/skip-providers";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { FixtureSourceLoader } from "../src/services/fixture-source.js";
import type {
  HlsResolvedResource,
  HlsSourceLoader,
  MediaInputSource,
} from "../src/services/hls-source-loader.js";
import type { EpisodeSourceResolver } from "../src/services/stremio-upstream/types.js";

const sourceResolver: EpisodeSourceResolver = {
  resolve: async (episodes) => ({
    familyMethod: "binge_group",
    familyKey: "internal-family",
    episodes: episodes.map((episode, index) => ({
      episodeId: episode.episodeId,
      upstreamType: episode.type,
      upstreamVideoId: episode.videoId,
      upstreamRank: index,
      familyMethod: "binge_group",
      familyKey: "internal-family",
      mediaSource: {
        kind: "http_media",
        episodeId: episode.episodeId,
        url: `https://signed.test/${episode.episodeId}?token=secret`,
      },
    })),
    unsupported: {
      torrent: 0,
      usenet: 0,
      archive: 0,
      youtube: 0,
      external: 0,
      unsupported: 0,
    },
    warnings: [],
  }),
};

class FixtureHttpLoader implements HlsSourceLoader {
  public playlistLoads = 0;
  public resourceOpens = 0;
  private readonly fixture = new FixtureSourceLoader(
    path.resolve("fixtures/hls"),
  );

  public loadPlaylist(source: MediaInputSource) {
    this.playlistLoads += 1;
    return this.fixture.loadPlaylist(this.fixtureSource(source));
  }

  public createResource(resolved: HlsResolvedResource) {
    const resource = this.fixture.createResource({
      source: this.fixtureSource(resolved.source),
      resource: resolved.resource,
    });
    return {
      ...resource,
      open: async (...args: Parameters<typeof resource.open>) => {
        this.resourceOpens += 1;
        return resource.open(...args);
      },
    };
  }

  private fixtureSource(source: MediaInputSource) {
    const number = source.episodeId.replace("ep", "");
    return {
      kind: "fixture_hls" as const,
      episodeId: source.episodeId,
      playlistUrl: `fixture://fmp4-episode${number}`,
    };
  }
}

const fixedProvider: SkipSegmentProvider = {
  name: "fixture-skip",
  priority: 1,
  supports: () => true,
  getSegments: async (request): Promise<SkipProviderResult> => ({
    provider: "fixture-skip",
    status: "found",
    warnings: [],
    segments: [
      {
        type: "opening",
        start: 0,
        end: 6,
        provider: "fixture-skip",
        automaticRemoval: true,
      },
      {
        type: "ending",
        start: 24,
        end: request.durationSeconds,
        provider: "fixture-skip",
        automaticRemoval: true,
      },
    ],
  }),
  checkHealth: async () => true,
};

describe("automatic skip development routes", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("resolves IMDb and explicit MAL identity into sanitized diagnostics", async () => {
    const app = createApp({ skipProviders: [fixedProvider] });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/skip/resolve",
      payload: {
        episodes: [
          {
            episodeId: "ep1",
            type: "series",
            videoId: "tt1234567:1:1",
            durationSeconds: 30,
            skipIdentity: { malAnimeId: 52_991, malEpisode: 1 },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      episodes: [
        {
          episodeId: "ep1",
          identity: { imdbAvailable: true, malAvailable: true },
          providers: [{ provider: "fixture-skip", status: "found" }],
        },
      ],
    });
    expect(response.body).not.toMatch(/tt1234567|52991/);
  });

  it("creates an automatic cut with one playlist load per episode and lazy resources", async () => {
    const sourceLoader = new FixtureHttpLoader();
    const app = createApp({
      sourceLoader,
      episodeSourceResolver: sourceResolver,
      skipProviders: [fixedProvider],
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts/from-upstream/auto",
      payload: {
        episodes: [1, 2, 3].map((episode) => ({
          episodeId: `ep${episode}`,
          type: "series",
          videoId: `tt1234567:1:${episode}`,
        })),
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      duration: number;
      playlistUrl: string;
      pieces: Array<{
        sourceEpisodeId: string;
        sourceStart: number;
        sourceEnd: number;
      }>;
      appliedCuts: Array<{
        status: string;
        requestedStart: number;
        requestedEnd: number;
        appliedStart: number;
        appliedEnd: number;
      }>;
      skipPlan: {
        automaticRemovals: unknown[];
        episodes: Array<{ segments: Array<{ decision: string }> }>;
      };
    }>();
    expect(sourceLoader.playlistLoads).toBe(3);
    expect(sourceLoader.resourceOpens).toBe(0);
    // With remove_all policy, all OP/ED are removed from all episodes
    // Total duration is 54s (all episodes have OP and ED removed)
    expect(body.duration).toBeCloseTo(54, 2);
    expect(body.appliedCuts).toHaveLength(6);
    expect(body.appliedCuts.every((cut) => cut.status === "applied")).toBe(
      true,
    );
    expect(body.skipPlan.automaticRemovals).toHaveLength(6);
    expect(
      body.skipPlan.episodes[0]!.segments.map((item) => item.decision),
    ).toEqual(["remove", "remove"]);
    expect(
      body.skipPlan.episodes[2]!.segments.map((item) => item.decision),
    ).toEqual(["remove", "remove"]);

    const playlist = await app.inject({ method: "GET", url: body.playlistUrl });
    const resourcePath = playlist.body
      .split("\n")
      .find(
        (line) => line.startsWith("/media/cut/") && !line.includes("master"),
      );
    expect(resourcePath).toBeDefined();
    await app.inject({ method: "GET", url: resourcePath! });
    expect(sourceLoader.resourceOpens).toBe(1);
    expect(response.body).not.toMatch(
      /signed\.test|token=secret|internal-family/,
    );
  });

  it("reports provider health without affecting basic health", async () => {
    const app = createApp({ skipProviders: [fixedProvider] });
    apps.push(app);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/dev/skip/health" })
      ).json(),
    ).toEqual({
      providers: [{ name: "fixture-skip", enabled: true, reachable: true }],
    });
    expect(
      (await app.inject({ method: "GET", url: "/health" })).json(),
    ).toEqual({
      status: "ok",
    });
  });
});
