import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetadataStremioClient,
  createVirtualMetaId,
} from "@animetvcut/stremio";
import { createApp } from "../src/app.js";
import {
  decodePreferences,
  encodePreferences,
} from "../src/services/playback-preferences.js";
import { OperationMetrics } from "../src/services/operation-metrics.js";
import { selectCandidateFamily } from "../src/services/stremio-upstream/family-selection.js";
import type {
  EpisodeCandidateSet,
  EpisodeSourceResolver,
  UrlStreamCandidate,
} from "../src/services/stremio-upstream/types.js";
import { NoConsistentStreamFamilyError } from "../src/services/stremio-upstream/errors.js";
import { explainCutFailure } from "../src/services/cut-availability.js";
import { operationalAlerts } from "../src/services/operational-alerts.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";

function metadata(released = "2020-01-01T00:00:00Z") {
  return new MetadataStremioClient(
    { manifestUrl: "https://metadata.test/private/secret/manifest.json" },
    async (input) => {
      const url = String(input);
      return Response.json(
        url.includes("manifest")
          ? {
              id: "test",
              name: "test",
              version: "1.0.0",
              types: ["series"],
              resources: ["catalog", "meta"],
              catalogs: [
                { id: "test", type: "series", extra: [{ name: "search" }] },
              ],
            }
          : url.includes("catalog")
            ? { metas: [{ id: "tt1234567", type: "series", name: "Fixture" }] }
            : {
                meta: {
                  id: "tt1234567",
                  type: "series",
                  name: "Fixture",
                  runtime: "1 min",
                  videos: Array.from({ length: 6 }, (_, i) => ({
                    id: `tt1234567:1:${i + 1}`,
                    season: 1,
                    episode: i + 1,
                    released,
                  })),
                },
              },
      );
    },
  );
}
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
const candidate = (rank: number, label: string): UrlStreamCandidate => ({
  kind: "url",
  rank,
  name: label,
  filename: `Show - 01 ${label}.mkv`,
  url: `https://source.test/${rank}.mkv`,
  bingeGroup: `group-${rank}`,
  requestHeaders: {},
  subtitles: [],
});

describe("configuration and preview", () => {
  it("keeps environment defaults and produces validated personal manifests without credentials", async () => {
    const app = createApp({
      publicBaseUrl: new URL("https://addon.test/"),
      metadataClient: metadata(),
    });
    apps.push(app);
    const page = await app.inject("/configure");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Install and preferences");
    const javascript = await app.inject("/configure.js");
    expect(javascript.statusCode).toBe(200);
    // Parse the delivered browser code to catch template escaping and syntax regressions.
    expect(() => new Script(javascript.body)).not.toThrow();
    const fullProfile = encodePreferences({
      episodesPerGroup: 2,
      openings: "keep_all",
      endings: "last_only",
      removeRecaps: true,
      removePreviews: true,
      language: "english",
      maxResolution: "1080",
      priority: "quality",
    });
    expect((await app.inject(`/p/${fullProfile}/configure`)).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject(`/p/${fullProfile}/v2/manifest.json`)).statusCode,
    ).toBe(200);
    const original = (await app.inject("/v2/manifest.json")).json();
    expect(original.id).toBe("org.animetvcut.addon.v2");
    expect(original.behaviorHints.configurable).toBe(true);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/configuration/profile",
      payload: { episodesPerGroup: 2, openings: "keep_all" },
    });
    expect(response.statusCode).toBe(200);
    const { profile, manifestUrl } = response.json<{
      profile: string;
      manifestUrl: string;
    }>();
    expect(manifestUrl).toBe(
      `https://addon.test/p/${profile}/v2/manifest.json`,
    );
    expect(decodePreferences(profile)).toEqual({
      episodesPerGroup: 2,
      openings: "keep_all",
    });
    const personal = (
      await app.inject(`/p/${profile}/v2/manifest.json`)
    ).json();
    expect(personal.id).not.toBe(original.id);
    const id = createVirtualMetaId("tt1234567");
    const standardMeta = (
      await app.inject(`/v2/meta/series/${id}.json`)
    ).json();
    const personalMeta = (
      await app.inject(`/p/${profile}/v2/meta/series/${id}.json`)
    ).json();
    expect(standardMeta.meta.videos).toHaveLength(2);
    expect(personalMeta.meta.videos).toHaveLength(3);
    const plan = await app.inject(`/p/${profile}/api/v1/preview/plan/${id}`);
    expect(plan.json().cuts).toHaveLength(3);
    expect(plan.body).not.toContain("secret");
    expect((await app.inject("/api/v1/configuration")).body).not.toContain(
      "secret",
    );
    for (const payload of [
      { episodesPerGroup: 5 },
      { language: "bad" },
      { url: "https://evil.test" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/configuration/profile",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect((await app.inject("/p/invalid/v2/manifest.json")).statusCode).toBe(
      400,
    );
  });
  it("explains pending cuts without resolving media and keeps operational endpoints protected", async () => {
    const resolve = vi.fn();
    const app = createApp({
      metadataClient: metadata(new Date().toISOString()),
      episodeSourceResolver: { resolve },
      devApiEnabled: true,
      devApiToken: "private-token",
    });
    apps.push(app);
    const id = createVirtualMetaId("tt1234567").replace(
      "atc:tv:",
      "atc:season:",
    );
    const plan = await app.inject(`/api/v1/preview/plan/${id}`);
    expect(plan.json().cuts[0]).toMatchObject({
      available: false,
      reason: "still_airing",
    });
    expect(resolve).not.toHaveBeenCalled();
    const details = await app.inject(`/v2/meta/series/${id}.json`);
    expect(details.json().meta.description).toContain("airing");
    for (const path of ["readiness", "alerts", "diagnostics"])
      expect((await app.inject(`/api/v1/dev/${path}`)).statusCode).toBe(401);
    const ready = await app.inject({
      url: "/api/v1/dev/readiness",
      headers: { authorization: "Bearer private-token" },
    });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain("secret");
    expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
  });
  it("offers a standard explanation link for failed Stremio sources", async () => {
    const app = createApp({
      metadataClient: metadata(),
      publicBaseUrl: new URL("https://addon.test/"),
      episodeSourceResolver: {
        resolve: async () => {
          throw new NoConsistentStreamFamilyError([]);
        },
      },
    });
    apps.push(app);
    const plan = (
      await app.inject(
        `/api/v1/preview/plan/${createVirtualMetaId("tt1234567")}`,
      )
    ).json();
    const id = plan.cuts[0].id as string;
    const response = await app.inject(`/v2/stream/series/${id}.json`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-animetvcut-reason"]).toBe("no_matching_release");
    expect(response.json().streams[0].externalUrl).toContain(
      "https://addon.test/configure#cut=",
    );
    expect(response.json().streams[0].title).toContain("No matching release");
    const preview = await app.inject(`/api/v1/preview/cut/${id}`);
    expect(preview.json().reason).toBe("no_matching_release");
    expect(preview.body).not.toContain("secret");
  });
  it("shares the concurrent build limit across default and personal installs", async () => {
    let entered!: () => void;
    let reject!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const app = createApp({
      metadataClient: metadata(),
      publicBaseUrl: new URL("https://addon.test/"),
      maxStreamBuilds: 1,
      episodeSourceResolver: {
        resolve: () => {
          entered();
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        },
      },
    });
    apps.push(app);
    const plan = (
      await app.inject(
        `/api/v1/preview/plan/${createVirtualMetaId("tt1234567")}`,
      )
    ).json();
    const id = plan.cuts[0].id as string;
    const first = app
      .inject(`/v2/stream/series/${id}.json`)
      .then((response) => response);
    await started;
    const profile = encodePreferences({ language: "english" });
    const next = await app.inject(`/p/${profile}/v2/stream/series/${id}.json`);
    expect(next.statusCode).toBe(503);
    expect(next.headers["x-animetvcut-reason"]).toBe("capacity");
    reject(new NoConsistentStreamFamilyError([]));
    await first;
  });
  it("prepares an accurate preview, reuses its session, forwards policy and never opens video", async () => {
    const resolver: EpisodeSourceResolver = {
      resolve: vi.fn(async (refs) => ({
        familyMethod: "binge_group",
        familyKey: "test",
        warnings: [],
        unsupported: {
          torrent: 0,
          usenet: 0,
          archive: 0,
          youtube: 0,
          external: 0,
          unsupported: 0,
        },
        episodes: refs.map((ref) => ({
          episodeId: ref.episodeId,
          upstreamType: ref.type,
          upstreamVideoId: ref.videoId,
          upstreamRank: 0,
          familyMethod: "binge_group",
          familyKey: "test",
          subtitles: [],
          mediaSource: {
            kind: "http_media",
            episodeId: ref.episodeId,
            url: "https://source.test/episode.mkv",
          },
        })),
      })),
    };
    const resolve = vi.spyOn(resolver, "resolve");
    const loadPlaylist = vi.fn(async () => ({
      targetDuration: 10,
      mediaSequence: 0,
      endList: true,
      version: 3,
      duration: 60,
      segments: Array.from({ length: 6 }, (_, i) => ({
        uri: `s${i}.ts`,
        absoluteUri: `https://media.test/s${i}.ts`,
        duration: 10,
        sequence: i,
        start: i * 10,
        end: (i + 1) * 10,
        discontinuity: false,
      })),
      container: "mpegts" as const,
    }));
    const open = vi.fn();
    const app = createApp({
      metadataClient: metadata(),
      episodeSourceResolver: resolver,
      publicBaseUrl: new URL("https://addon.test/"),
      sourceLoader: {
        loadPlaylist,
        createResource: () => ({ contentType: "video/mp2t", open }),
      },
      skipProviders: [
        {
          name: "fixed",
          priority: 1,
          supports: () => true,
          getSegments: async () => ({
            provider: "fixed",
            status: "found",
            warnings: [],
            segments: [
              {
                type: "opening",
                start: 0,
                end: 10,
                provider: "fixed",
                automaticRemoval: true,
              },
            ],
          }),
        },
      ],
    });
    apps.push(app);
    const plan = (
      await app.inject(
        `/api/v1/preview/plan/${createVirtualMetaId("tt1234567")}`,
      )
    ).json();
    const id = plan.cuts[0].id;
    const prepared = await app.inject(`/api/v1/preview/cut/${id}`);
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({
      duration: 150,
      episodes: [{ episode: 1 }, { episode: 2 }, { episode: 3 }],
      removals: [
        { start: 0, end: 10 },
        { start: 0, end: 10 },
        { start: 0, end: 10 },
      ],
    });
    expect(open).not.toHaveBeenCalled();
    const stream = (await app.inject(`/v2/stream/series/${id}.json`)).json();
    expect(stream.streams[0].url).toBe(prepared.json().playlistUrl);
    expect(loadPlaylist).toHaveBeenCalledTimes(3);
    const profile = encodePreferences({
      openings: "keep_all",
      language: "english",
      maxResolution: "720",
    });
    const kept = await app.inject(`/p/${profile}/api/v1/preview/cut/${id}`);
    expect(kept.statusCode).toBe(200);
    expect(kept.json().duration).toBe(180);
    expect(kept.json().removals).toHaveLength(0);
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preferences: {
          openings: "keep_all",
          language: "english",
          maxResolution: "720",
        },
      }),
    );
    const metrics = (await app.inject("/api/v1/dev/diagnostics")).json()
      .preparation;
    expect(metrics.cut_tv.count).toBe(2);
    expect(metrics.cut_tv.p95Ms).toBeGreaterThanOrEqual(0);
  });
});

describe("source preferences and metrics", () => {
  const sets = (candidates: UrlStreamCandidate[]): EpisodeCandidateSet[] => [
    {
      reference: { episodeId: "ep1", videoId: "ep1", type: "series" },
      candidates,
    },
  ];
  it("honors resolution caps and quality versus startup preferences", () => {
    const values = sets([
      candidate(0, "2160p HEVC JPN"),
      candidate(1, "1080p H264 JPN AAC"),
      candidate(2, "720p H264 ENG AAC"),
    ]);
    expect(
      selectCandidateFamily(values, { preferMediaFlowCompatible: true })
        .episodes[0]?.upstreamRank,
    ).toBe(1);
    expect(
      selectCandidateFamily(values, {
        preferMediaFlowCompatible: true,
        preferences: { priority: "quality" },
      }).episodes[0]?.upstreamRank,
    ).toBe(0);
    expect(
      selectCandidateFamily(values, {
        preferMediaFlowCompatible: true,
        preferences: { maxResolution: "720" },
      }).episodes[0]?.upstreamRank,
    ).toBe(2);
    expect(
      selectCandidateFamily(values, {
        preferMediaFlowCompatible: true,
        preferences: { language: "english" },
      }).episodes[0]?.upstreamRank,
    ).toBe(2);
    expect(
      explainCutFailure(new NoConsistentStreamFamilyError([])).reason,
    ).toBe("no_matching_release");
  });
  it("keeps only 256 latency samples and reports actionable alerts", () => {
    const metrics = new OperationMetrics();
    for (let i = 0; i < 300; i++) metrics.record("playback", i, i === 299);
    expect(metrics.snapshot().playback).toMatchObject({
      count: 300,
      sampleCount: 256,
      p50Ms: 171,
      p95Ms: 287,
      p99Ms: 297,
      recentFailures: 1,
    });
    expect(
      operationalAlerts(
        new CutSessionStore().stats(),
        metrics.snapshot(),
        8,
        8,
      ).map((a) => a.code),
    ).toEqual(["build_pressure", "playback_failures"]);
  });
});
