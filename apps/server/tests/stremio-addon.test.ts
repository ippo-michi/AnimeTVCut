import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import net from "node:net";

import { DEFAULT_TV_CUT_GROUPING_CONFIG } from "@animetvcut/core";
import {
  MetadataStremioClient,
  createVirtualMetaId,
  createVirtualVideoId,
} from "@animetvcut/stremio";

import { createApp } from "../src/app.js";
import { publicStremioRoutes } from "../src/routes/stremio-addon.js";
import type { CutService } from "../src/services/cut-service.js";
import { MediaFlowUnavailableError } from "../src/services/mediaflow/errors.js";
import { metadataConfigurationFromEnv } from "../src/services/metadata-config.js";
import { DEFAULT_LONG_CUT_CONFIGURATION } from "../src/services/metadata-config.js";
import { TvCutCatalogService } from "../src/services/tv-cut-catalog-service.js";
import {
  NoConsistentStreamFamilyError,
  NoUsableStreamsError,
  StremioUpstreamUnavailableError,
} from "../src/services/stremio-upstream/errors.js";
import type {
  AutomaticUpstreamCutRequest,
  UpstreamCutService,
} from "../src/services/upstream-cut-service.js";
import { mediaRoutes } from "../src/routes/media.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import {
  CutWatchProgressTracker,
  type EpisodeWatchProgressReporter,
} from "../src/services/watch-progress.js";

const sourceId = "opaque:fixture:series/α";
const frierenSourceId = "tt22248376";
const frierenMetaIds = [
  "atc:tv:dHQyMjI0ODM3Ng",
  "atc:season:dHQyMjI0ODM3Ng",
  "atc:series:dHQyMjI0ODM3Ng",
] as const;
const manifest = {
  id: "fixture.metadata",
  name: "Fixture AIOMetadata",
  version: "1.0.0",
  types: ["series"],
  resources: ["catalog", "meta"],
  catalogs: [
    { id: "first-movie", type: "movie", extra: [{ name: "search" }] },
    {
      id: "fixture-series",
      type: "series",
      extra: [{ name: "search", isRequired: true }, { name: "skip" }],
    },
  ],
};

function seriesMeta() {
  return {
    id: sourceId,
    type: "series",
    name: "Synthetic Six",
    runtime: "24 min",
    poster: "https://images.test/poster.jpg",
    videos: Array.from({ length: 6 }, (_, index) => ({
      id: `opaque:exact:episode:${index + 1}`,
      season: 1,
      episode: index + 1,
      title: `Episode ${index + 1}`,
      released: "2025-01-01T00:00:00Z",
    })),
  };
}

function metadataClient(
  onCatalogUrl?: (url: URL) => void,
  sourceMeta: ReturnType<typeof seriesMeta> = seriesMeta(),
) {
  return new MetadataStremioClient(
    {
      manifestUrl:
        "https://metadata.test/config/private-token/manifest.json?api_key=secret",
      manifestCacheTtlMs: 60_000,
      catalogCacheTtlMs: 60_000,
      metaCacheTtlMs: 60_000,
    },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        return new Response(JSON.stringify(manifest));
      }
      if (url.pathname.includes("/catalog/")) {
        onCatalogUrl?.(url);
        return new Response(
          JSON.stringify({
            metas: [
              {
                id: sourceMeta.id,
                type: "series",
                name: sourceMeta.name,
                poster: sourceMeta.poster,
                unsafe: "must-not-pass",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ meta: sourceMeta }));
    },
  );
}

describe("public Stremio addon", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("publishes a search-only series addon with scoped CORS", async () => {
    const app = createApp({ metadataClient: metadataClient() });
    apps.push(app);
    const manifestResponse = await app.inject({
      method: "GET",
      url: "/manifest.json",
    });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.headers["access-control-allow-origin"]).toBe("*");
    expect(manifestResponse.json()).toMatchObject({
      id: "org.animetvcut.addon",
      version: "0.2.0",
      types: ["series"],
      catalogs: [
        {
          id: "animetvcut",
          type: "series",
          extra: [{ name: "search", isRequired: true }],
        },
      ],
    });
    const empty = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut.json",
    });
    expect(empty.json()).toEqual({ metas: [] });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("publishes a clean v2 identity with a search-only catalog", async () => {
    const app = createApp({ metadataClient: metadataClient() });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/manifest-v2.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.json()).toMatchObject({
      id: "org.animetvcut.addon.v2",
      version: "0.2.0",
      catalogs: [
        {
          id: "animetvcut-v2",
          type: "series",
          extra: [{ name: "search", isRequired: true }],
        },
      ],
    });

    const catalog = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=Frieren&skip=0.json",
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metas).toHaveLength(3);
    expect(catalog.headers["cache-control"]).toBe("no-store, max-age=0");

    const installableManifest = await app.inject({
      method: "GET",
      url: "/v2/manifest.json",
    });
    expect(installableManifest.statusCode).toBe(200);
    expect(installableManifest.json()).toEqual(response.json());

    const prefixedCatalog = await app.inject({
      method: "GET",
      url: "/v2/catalog/series/animetvcut-v2/search=Frieren&skip=0.json",
    });
    expect(prefixedCatalog.statusCode).toBe(200);
    expect(prefixedCatalog.json().metas).toHaveLength(3);
  });

  it("answers a legacy skip > 0 with an empty catalog and no upstream request", async () => {
    const catalogRequests: URL[] = [];
    const app = createApp({
      metadataClient: metadataClient((url) => catalogRequests.push(url)),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut/search=Frieren&skip=1.json",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ metas: [] });
    expect(catalogRequests).toEqual([]);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  });

  it("never forwards a skip parameter upstream on page zero", async () => {
    const catalogRequests: URL[] = [];
    const app = createApp({
      metadataClient: metadataClient((url) => catalogRequests.push(url)),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=Frieren&skip=0.json",
    });
    expect(response.statusCode).toBe(200);
    expect(catalogRequests).toHaveLength(1);
    expect(catalogRequests[0]!.pathname).not.toContain("skip");
    expect(response.json().metas).toHaveLength(3);
  });

  it("returns the same search results after a prior selection", async () => {
    const app = createApp({ metadataClient: metadataClient() });
    apps.push(app);
    const url = "/catalog/series/animetvcut/search=Frieren&skip=0.json";
    const first = await app.inject({ method: "GET", url });
    const second = await app.inject({ method: "GET", url });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.json().metas).toHaveLength(3);
  });

  it.each(["-1", "NaN", "100000000000000000000"])(
    "rejects malformed legacy skip %s without an upstream request",
    async (skip) => {
      const catalogRequests: URL[] = [];
      const app = createApp({
        metadataClient: metadataClient((url) => catalogRequests.push(url)),
      });
      apps.push(app);
      const response = await app.inject({
        method: "GET",
        url: `/catalog/series/animetvcut/search=Frieren&skip=${skip}.json`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ metas: [] });
      expect(catalogRequests).toEqual([]);
    },
  );

  it("returns 200 with empty metas when the metadata backend fails", async () => {
    const failingClient = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        requestTimeoutMs: 2_000,
      },
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    const app = createApp({ metadataClient: failingClient });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=Frieren.json",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ metas: [] });
  });

  it("exposes only virtual atc cut ids in successful search results", async () => {
    const app = createApp({ metadataClient: metadataClient() });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=Frieren.json",
    });
    expect(response.statusCode).toBe(200);
    const metas = response.json().metas as { id: string }[];
    expect(metas).toHaveLength(3);
    expect(
      metas.every((meta) => /^atc:(tv|season|series):/.test(meta.id)),
    ).toBe(true);
  });

  it("transforms safe catalog previews and emits finalized virtual groups", async () => {
    const app = createApp({
      metadataClient: metadataClient(),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    apps.push(app);
    const catalog = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut/search=Synthetic&skip=0.json",
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.body).not.toContain("unsafe");
    expect(catalog.json().metas).toEqual([
      expect.objectContaining({
        id: createVirtualMetaId(sourceId),
        name: "Synthetic Six — TV Cut",
      }),
      expect.objectContaining({ name: "Synthetic Six — Season Cut" }),
      expect.objectContaining({ name: "Synthetic Six — Complete Cut" }),
    ]);
    const meta = await app.inject({
      method: "GET",
      url: `/meta/series/${encodeURIComponent(createVirtualMetaId(sourceId))}.json`,
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().meta.videos).toEqual([
      expect.objectContaining({
        id: createVirtualVideoId(sourceId, 1, 1, 3),
        episode: 1,
      }),
      expect.objectContaining({
        id: createVirtualVideoId(sourceId, 1, 4, 6),
        episode: 2,
      }),
    ]);
    expect(meta.body).not.toContain("opaque:exact:episode");

    const seasonCatalogItem = catalog.json().metas[1] as { id: string };
    const seasonMeta = await app.inject({
      method: "GET",
      url: `/meta/series/${encodeURIComponent(seasonCatalogItem.id)}.json`,
    });
    expect(seasonMeta.json().meta.videos).toEqual([
      expect.objectContaining({
        season: 1,
        episode: 1,
        title: "Season 1 — Complete (Episodes 1–6)",
      }),
    ]);
    const completeCatalogItem = catalog.json().metas[2] as { id: string };
    const completeMeta = await app.inject({
      method: "GET",
      url: `/meta/series/${encodeURIComponent(completeCatalogItem.id)}.json`,
    });
    expect(completeMeta.json().meta.videos).toEqual([
      expect.objectContaining({
        season: 1,
        episode: 1,
        title: "Complete Series — 6 Episodes",
      }),
    ]);
  });

  it("does not advertise season-zero shorts as the first TV Cut part", async () => {
    const normal = seriesMeta();
    const app = createApp({
      metadataClient: metadataClient(undefined, {
        ...normal,
        videos: [
          {
            id: "opaque:special:1",
            season: 0,
            episode: 1,
            title: "Mini Anime",
            released: "2025-01-01T00:00:00Z",
          },
          ...normal.videos,
        ],
      }),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/meta/series/${encodeURIComponent(createVirtualMetaId(sourceId))}.json`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .meta.videos.map((video: { season: number }) => video.season),
    ).toEqual([1, 1]);
    expect(response.body).not.toContain("Mini Anime");
  });

  it("publishes stable three-episode parts for an eleven-episode season", async () => {
    const source = seriesMeta();
    const app = createApp({
      metadataClient: metadataClient(undefined, {
        ...source,
        runtime: "27 min",
        videos: Array.from({ length: 11 }, (_, index) => ({
          id: `opaque:eleven:${index + 1}`,
          season: 1,
          episode: index + 1,
          released: "2025-01-01T00:00:00Z",
        })),
      }),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/meta/series/${encodeURIComponent(createVirtualMetaId(sourceId))}.json`,
    });
    expect(
      response
        .json()
        .meta.videos.map((video: { title: string }) => video.title),
    ).toEqual([
      "Part 1 (Episodes 1–3)",
      "Part 2 (Episodes 4–6)",
      "Part 3 (Episodes 7–9)",
      "Part 4 (Episodes 10–11)",
    ]);
  });

  it("does not expose metadata credentials in diagnostics", async () => {
    const app = createApp({ metadataClient: metadataClient() });
    apps.push(app);
    const health = await app.inject({
      method: "GET",
      url: "/api/v1/dev/metadata/health",
    });
    expect(health.json()).toMatchObject({
      configured: true,
      origin: "https://metadata.test",
      catalogId: "fixture-series",
    });
    expect(health.body).not.toMatch(/private-token|api_key|secret/);
  });

  it("honors mode exposure without affecting TV Cut", async () => {
    const app = createApp({
      metadataClient: metadataClient(),
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      longCuts: {
        ...DEFAULT_LONG_CUT_CONFIGURATION,
        exposeSeason: false,
        exposeSeries: false,
      },
    });
    apps.push(app);
    const catalog = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut/search=Synthetic.json",
    });
    expect(catalog.json().metas).toEqual([
      expect.objectContaining({ name: "Synthetic Six — TV Cut" }),
    ]);
  });
});

describe("search sequence regression: Frieren, other query, Frieren again", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  function frierenMeta() {
    return {
      id: frierenSourceId,
      type: "series",
      name: "Frieren: Beyond Journey's End",
      runtime: "24 min",
      poster: "https://images.test/poster.jpg",
      videos: Array.from({ length: 28 }, (_, index) => ({
        id: `tt22248376:1:${index + 1}`,
        season: 1,
        episode: index + 1,
        title: `Episode ${index + 1}`,
        released: "2025-01-01T00:00:00Z",
      })),
    };
  }

  it("settles catalog -> meta follow-ups -> other query -> same query -> meta again", async () => {
    const client = metadataClient(undefined, frierenMeta());
    const app = createApp({
      metadataClient: client,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    apps.push(app);

    const catalog = (query: string) =>
      app.inject({
        method: "GET",
        url: `/v2/catalog/series/animetvcut-v2/search=${encodeURIComponent(query)}.json`,
      });
    const meta = (id: string) =>
      app.inject({
        method: "GET",
        url: `/v2/meta/series/${id}.json`,
      });

    const first = await catalog("Frieren");
    expect(first.statusCode).toBe(200);
    expect(first.json().metas.map((item: { id: string }) => item.id)).toEqual([
      ...frierenMetaIds,
    ]);
    const statsAfterFirstCatalog = client.stats;
    expect(statsAfterFirstCatalog).toEqual({
      manifestRequests: 1,
      catalogRequests: 1,
      metaRequests: 0,
    });

    for (const id of frierenMetaIds) {
      const response = await meta(id);
      expect(response.statusCode).toBe(200);
      expect(response.json().meta.videos.length).toBeGreaterThan(0);
    }
    expect(client.stats).toEqual({
      manifestRequests: 1,
      catalogRequests: 1,
      metaRequests: 1,
    });

    const other = await catalog("One Piece");
    expect(other.statusCode).toBe(200);
    expect(client.stats).toEqual({
      manifestRequests: 1,
      catalogRequests: 2,
      metaRequests: 1,
    });

    const second = await catalog("Frieren");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Second identical query is served entirely from the catalog cache.
    expect(client.stats).toEqual({
      manifestRequests: 1,
      catalogRequests: 2,
      metaRequests: 1,
    });

    for (const id of frierenMetaIds) {
      const response = await meta(id);
      expect(response.statusCode).toBe(200);
      expect(response.json().meta.videos.length).toBeGreaterThan(0);
    }
    // All follow-up meta requests are served from the meta cache.
    expect(client.stats).toEqual({
      manifestRequests: 1,
      catalogRequests: 2,
      metaRequests: 1,
    });
  });
});

describe("public TV Cut stream authorization and caching", () => {
  it("regenerates the current plan, forwards exact episode IDs, and coalesces cache hits", async () => {
    const createAutomaticCut = vi.fn(async () => ({
      cutId: "active-cut",
      playlistUrl: "/media/cut/active-cut/master.m3u8",
    }));
    const enableWatchProgress = vi.fn();
    const service = new TvCutCatalogService(
      metadataClient(),
      { createAutomaticCut } as unknown as UpstreamCutService,
      {
        isCutActive: () => true,
        enableWatchProgress,
      } as unknown as CutService,
      new URL("https://public.animetvcut.test/"),
      DEFAULT_TV_CUT_GROUPING_CONFIG,
      () => Date.parse("2026-01-01T00:00:00Z"),
    );
    const videoId = createVirtualVideoId(sourceId, 1, 1, 3);
    const [first, second] = await Promise.all([
      service.publicStream(videoId),
      service.publicStream(videoId),
    ]);
    expect(first).toEqual(second);
    expect(first.streams[0]?.url).toBe(
      "https://public.animetvcut.test/media/cut/active-cut/master.m3u8",
    );
    expect(createAutomaticCut).toHaveBeenCalledTimes(1);
    expect(createAutomaticCut.mock.calls[0]?.[0].episodes).toEqual(
      [1, 2, 3].map((episode) => ({
        episodeId: `opaque:exact:episode:${episode}`,
        type: "series",
        videoId: `opaque:exact:episode:${episode}`,
      })),
    );
    expect(enableWatchProgress).toHaveBeenCalledWith("active-cut", [
      "opaque:exact:episode:1",
      "opaque:exact:episode:2",
      "opaque:exact:episode:3",
    ]);
  });

  it("propagates MAL through matching IMDb episodes without requiring Kitsu", async () => {
    const createAutomaticCut = vi.fn(async () => ({
      cutId: "active-imdb-cut",
      playlistUrl: "/media/cut/active-imdb-cut/master.m3u8",
    }));
    const source = {
      ...seriesMeta(),
      id: "tt0315008",
      name: "IMDb fixture",
      _malId: "245",
      videos: Array.from({ length: 3 }, (_, index) => ({
        id: `tt0315008:1:${index + 1}`,
        season: 1,
        episode: index + 1,
        released: "2025-01-01T00:00:00Z",
      })),
    } as ReturnType<typeof seriesMeta> & { _malId: string };
    const service = new TvCutCatalogService(
      metadataClient(undefined, source),
      { createAutomaticCut } as unknown as UpstreamCutService,
      {
        isCutActive: () => true,
        enableWatchProgress: vi.fn(),
      } as unknown as CutService,
      new URL("https://public.animetvcut.test/"),
      DEFAULT_TV_CUT_GROUPING_CONFIG,
      () => Date.parse("2026-01-01T00:00:00Z"),
    );
    await service.publicStream(createVirtualVideoId("tt0315008", 1, 1, 3));
    const request = createAutomaticCut.mock.calls[0]?.[0] as
      AutomaticUpstreamCutRequest | undefined;
    expect(request?.episodes.map((episode) => episode.skipIdentity)).toEqual(
      [1, 2, 3].map((episode) => ({
        imdbId: "tt0315008",
        imdbSeason: 1,
        imdbEpisode: episode,
        malAnimeId: 245,
        malEpisode: episode,
      })),
    );
  });

  it("uses an exact metadata MAL/Kitsu pair without leaking it across seasons", async () => {
    const createAutomaticCut = vi.fn(async () => ({
      cutId: `active-cut-${createAutomaticCut.mock.calls.length}`,
      playlistUrl: `/media/cut/active-cut-${createAutomaticCut.mock.calls.length}/master.m3u8`,
    }));
    const source = {
      ...seriesMeta(),
      _malId: "52034",
      _kitsuId: "46170",
      videos: [
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `kitsu:46170:${index + 1}`,
          season: 1,
          episode: index + 1,
          released: "2025-01-01T00:00:00Z",
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `kitsu:47659:${index + 1}`,
          season: 2,
          episode: index + 1,
          released: "2025-01-01T00:00:00Z",
        })),
      ],
    } as ReturnType<typeof seriesMeta> & {
      _malId: string;
      _kitsuId: string;
    };
    const service = new TvCutCatalogService(
      metadataClient(undefined, source),
      { createAutomaticCut } as unknown as UpstreamCutService,
      {
        isCutActive: () => true,
        enableWatchProgress: vi.fn(),
      } as unknown as CutService,
      new URL("https://public.animetvcut.test/"),
      DEFAULT_TV_CUT_GROUPING_CONFIG,
      () => Date.parse("2026-01-01T00:00:00Z"),
    );
    await service.publicStream(createVirtualVideoId(sourceId, 1, 1, 3));
    await service.publicStream(createVirtualVideoId(sourceId, 2, 1, 3));
    const firstRequest = createAutomaticCut.mock.calls[0]?.[0] as
      AutomaticUpstreamCutRequest | undefined;
    const secondRequest = createAutomaticCut.mock.calls[1]?.[0] as
      AutomaticUpstreamCutRequest | undefined;
    expect(
      firstRequest?.episodes.map((episode) => episode.skipIdentity),
    ).toEqual(
      [1, 2, 3].map((episode) => ({
        malAnimeId: 52_034,
        malEpisode: episode,
      })),
    );
    expect(
      secondRequest?.episodes.every(
        (episode) => episode.skipIdentity === undefined,
      ),
    ).toBe(true);
  });

  it("rejects a syntactically valid group absent from the current plan", async () => {
    const service = new TvCutCatalogService(
      metadataClient(),
      { createAutomaticCut: vi.fn() } as unknown as UpstreamCutService,
      {
        isCutActive: () => true,
        enableWatchProgress: vi.fn(),
      } as unknown as CutService,
      new URL("https://public.animetvcut.test/"),
      DEFAULT_TV_CUT_GROUPING_CONFIG,
      () => Date.parse("2026-01-01T00:00:00Z"),
    );
    await expect(
      service.publicStream(createVirtualVideoId(sourceId, 1, 2, 4)),
    ).rejects.toThrow(/current finalized grouping plan/);
  });
});

describe("metadata environment configuration", () => {
  it("defaults grouping and does not require metadata at startup", () => {
    const config = metadataConfigurationFromEnv({});
    expect(config.stremio).toBeUndefined();
    expect(config.grouping).toEqual(DEFAULT_TV_CUT_GROUPING_CONFIG);
    expect(config.longCuts).toEqual(DEFAULT_LONG_CUT_CONFIGURATION);
    expect(config.aiometadataWatchTracking).toBe(true);
  });

  it("treats an empty optional catalog ID as automatic selection", () => {
    const config = metadataConfigurationFromEnv({
      METADATA_STREMIO_MANIFEST_URL: "https://meta.test/manifest.json",
      METADATA_STREMIO_SEARCH_CATALOG_ID: "   ",
    });
    expect(config.stremio?.searchCatalogId).toBeUndefined();
  });

  it("normalizes the public origin and metadata timeout", () => {
    const config = metadataConfigurationFromEnv({
      PUBLIC_BASE_URL: "https://cuts.example.test",
      METADATA_STREMIO_MANIFEST_URL: "https://meta.test/manifest.json",
      METADATA_STREMIO_REQUEST_TIMEOUT_MS: "9000",
    });
    expect(config.publicBaseUrl?.href).toBe("https://cuts.example.test/");
    expect(config.stremio?.requestTimeoutMs).toBe(9000);
  });

  it("supports explicitly disabling AIOMetadata watch tracking", () => {
    const config = metadataConfigurationFromEnv({
      AIOMETADATA_WATCH_TRACKING_ENABLED: "false",
    });
    expect(config.aiometadataWatchTracking).toBe(false);
  });
});

describe("public stream failure behavior", () => {
  it.each([
    new NoUsableStreamsError({
      episodeId: "opaque",
      upstreamResults: 0,
      usableUrlCandidates: 0,
      stableFamilyCandidates: 0,
    }),
    new NoConsistentStreamFamilyError([]),
    new StremioUpstreamUnavailableError(),
  ])(
    "returns an empty stream list for source resolution failure",
    async (error) => {
      const app = Fastify();
      await app.register(
        publicStremioRoutes({
          publicStream: async () => {
            throw error;
          },
        } as unknown as TvCutCatalogService),
      );
      const response = await app.inject({
        method: "GET",
        url: "/stream/series/atc:tv:invalid.json",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ streams: [] });
      await app.close();
    },
  );

  it("uses an infrastructure status when MediaFlow is unavailable", async () => {
    const app = Fastify();
    await app.register(
      publicStremioRoutes({
        publicStream: async () => {
          throw new MediaFlowUnavailableError();
        },
      } as unknown as TvCutCatalogService),
    );
    const response = await app.inject({
      method: "GET",
      url: "/stream/series/atc:tv:invalid.json",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ streams: [] });
    await app.close();
  });
});

describe("search does not invoke watch-progress reporter", () => {
  it("catalog search never calls reportEpisodeWatched", async () => {
    const reportEpisodeWatched = vi.fn<
      Parameters<EpisodeWatchProgressReporter["reportEpisodeWatched"]>,
      ReturnType<EpisodeWatchProgressReporter["reportEpisodeWatched"]>
    >(async () => "triggered");
    const reporter: EpisodeWatchProgressReporter = { reportEpisodeWatched };
    const tracker = new CutWatchProgressTracker(reporter);

    const app = Fastify();
    await app.register(
      publicStremioRoutes({
        search: async () => [{ id: "test", type: "series", name: "Test" }],
      } as unknown as TvCutCatalogService),
    );
    await app.register(
      mediaRoutes(new CutSessionStore(), undefined, 0, tracker),
    );

    // Perform a catalog search
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=test.json",
    });
    expect(response.statusCode).toBe(200);

    // Watch progress reporter must never be called during search
    expect(reportEpisodeWatched).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("public catalog route safety boundary", () => {
  it("route timeout aborts service.search when it never resolves", async () => {
    let searchAborted = false;

    const app = Fastify();
    await app.register(
      publicStremioRoutes(
        {
          search: async (_query: string, signal?: AbortSignal) => {
            // Simulate a search that hangs until aborted
            await new Promise<void>((resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  searchAborted = true;
                  reject(new Error("Search was aborted by route timeout"));
                },
                { once: true },
              );
            });
            return [{ id: "test", type: "series", name: "Test" }];
          },
        } as unknown as TvCutCatalogService,
        { routeTimeoutMs: 50 },
      ),
    );

    const start = Date.now();
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=test.json",
    });
    const elapsed = Date.now() - start;

    // Route timeout should abort the search, which throws, and the
    // route handler catches it and returns 200 with empty metas.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ metas: [] });
    expect(searchAborted).toBe(true);
    // Should complete within route timeout + small margin, not 30 seconds
    expect(elapsed).toBeLessThan(2000);
    await app.close();
  });

  it("response-side close observer is wired", async () => {
    const app = Fastify();
    // Use a fast route timeout so the test completes quickly even
    // if the mock hangs waiting for abort.
    await app.register(
      publicStremioRoutes(
        {
          search: async (_query: string, signal?: AbortSignal) => {
            // Simulate a search that hangs until aborted
            await new Promise<void>((resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  reject(new Error("Search was aborted"));
                },
                { once: true },
              );
            });
            return [{ id: "test", type: "series", name: "Test" }];
          },
        } as unknown as TvCutCatalogService,
        { routeTimeoutMs: 50 },
      ),
    );

    // The route should complete via timeout (50ms) rather than hanging
    // for the full routeTimeoutMs (10_000ms default).
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=test.json",
    });

    // Route timeout fires, aborts the search, handler catches error
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ metas: [] });
    await app.close();
  });
});

describe("public catalog route hard deadline and disconnect", () => {
  it("route timeout is a hard deadline even when service.search ignores abort", async () => {
    // service.search returns a promise that never resolves and never
    // inspects the signal — simulates a buggy upstream that ignores
    // cancellation entirely.
    const app = Fastify();
    await app.register(
      publicStremioRoutes(
        {
          search: async () =>
            new Promise<readonly StremioMetaPreview[]>(() => {
              // Never resolves, never rejects, never inspects signal
            }),
        } as unknown as TvCutCatalogService,
        { routeTimeoutMs: 50 },
      ),
    );

    const start = Date.now();
    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut-v2/search=test.json",
    });
    const elapsed = Date.now() - start;

    // Must complete within the route timeout, not hang forever.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ metas: [] });
    expect(elapsed).toBeLessThan(2000);
    await app.close();
  });

  it("client disconnect aborts service.search signal via real socket", async () => {
    let signalAborted = false;
    // Two separate deferred promises for explicit synchronization:
    // - searchStarted: resolved when service.search() starts (request received)
    // - signalAborted: resolved when the AbortSignal fires (server detects disconnect)
    let resolveSearchStarted!: () => void;
    const searchStarted = new Promise<void>(
      (resolve) => (resolveSearchStarted = resolve),
    );
    let resolveSignalAborted!: () => void;
    const signalAbortedPromise = new Promise<void>(
      (resolve) => (resolveSignalAborted = resolve),
    );

    const app = Fastify();
    let socketRef: net.Socket | undefined;

    try {
      // Register routes BEFORE listening (Fastify requires this order).
      await app.register(
        publicStremioRoutes(
          {
            search: async (_query: string, signal?: AbortSignal) => {
              // Signal that the handler has started so the test knows it's
              // safe to destroy the socket.
              resolveSearchStarted();
              // Wait for signal to abort — simulates a search that hangs.
              await new Promise<void>((resolve) => {
                signal?.addEventListener(
                  "abort",
                  () => {
                    signalAborted = true;
                    resolveSignalAborted();
                    resolve();
                  },
                  { once: true },
                );
              });
              return [{ id: "test", type: "series", name: "Test" }];
            },
          } as unknown as TvCutCatalogService,
          { routeTimeoutMs: 10_000 },
        ),
      );

      // Start the server on loopback with an ephemeral port.
      await app.listen({ port: 0, host: "127.0.0.1" });
      const addr = app.server.address()!;
      const port = typeof addr === "string" ? 0 : addr.port;

      // Connect via net.Socket, send request, then destroy the socket
      // to simulate client disconnect.
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ port, host: "127.0.0.1" }, () => {
          socketRef = socket;
          socket.write(
            `GET /catalog/series/animetvcut-v2/search=test.json HTTP/1.1\r\n` +
              "Host: 127.0.0.1\r\n" +
              "Connection: close\r\n" +
              "\r\n",
          );
        });

        socket.on("error", reject);

        // Wait for the handler to start, then destroy the socket.
        // This proves the full chain:
        // HTTP request reaches handler -> handler starts -> socket destroyed
        // -> server detects disconnect -> AbortSignal fires.
        void searchStarted.then(() => {
          socket.destroy();
        });

        socket.on("close", () => {
          resolve();
        });
      });

      // Wait for the server to detect the disconnect via the AbortSignal.
      await signalAbortedPromise;

      expect(signalAborted).toBe(true);
    } finally {
      socketRef?.destroy();
      await app.close();
    }
  });
});
