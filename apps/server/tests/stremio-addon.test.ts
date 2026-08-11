import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

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
import type { UpstreamCutService } from "../src/services/upstream-cut-service.js";

const sourceId = "opaque:fixture:series/α";
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

function metadataClient(onCatalogUrl?: (url: URL) => void) {
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
            metas: url.pathname.includes("skip=3")
              ? [
                  { id: "unrelated-a", type: "series", name: "Unrelated A" },
                  { id: "unrelated-b", type: "series", name: "Unrelated B" },
                ]
              : [
                  {
                    id: sourceId,
                    type: "series",
                    name: "Synthetic Six",
                    poster: "https://images.test/poster.jpg",
                    unsafe: "must-not-pass",
                  },
                ],
          }),
        );
      }
      return new Response(JSON.stringify({ meta: seriesMeta() }));
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
      version: "0.1.1",
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

  it("terminates legacy output pagination without forwarding skip upstream", async () => {
    const catalogRequests: URL[] = [];
    const app = createApp({
      metadataClient: metadataClient((url) => catalogRequests.push(url)),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/catalog/series/animetvcut/search=Frieren&skip=3.json",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ metas: [] });
    expect(catalogRequests).toEqual([]);
    expect(response.body).not.toMatch(/Unrelated A|Unrelated B/);
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

describe("public TV Cut stream authorization and caching", () => {
  it("regenerates the current plan, forwards exact episode IDs, and coalesces cache hits", async () => {
    const createAutomaticCut = vi.fn(async () => ({
      cutId: "active-cut",
      playlistUrl: "/media/cut/active-cut/master.m3u8",
    }));
    const service = new TvCutCatalogService(
      metadataClient(),
      { createAutomaticCut } as unknown as UpstreamCutService,
      { isCutActive: () => true } as unknown as CutService,
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
  });

  it("rejects a syntactically valid group absent from the current plan", async () => {
    const service = new TvCutCatalogService(
      metadataClient(),
      { createAutomaticCut: vi.fn() } as unknown as UpstreamCutService,
      { isCutActive: () => true } as unknown as CutService,
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
