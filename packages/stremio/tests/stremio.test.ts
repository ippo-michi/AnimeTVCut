import { describe, expect, it, vi } from "vitest";

import {
  MetadataStremioClient,
  MetadataStremioCompatibilityError,
  MetadataStremioConfigurationError,
  createVirtualMetaId,
  createVirtualVideoId,
  deriveStremioResourceUrl,
  parseMetadataManifest,
  parseVirtualMetaId,
  parseVirtualVideoId,
} from "../src/index.js";

const manifest = {
  id: "fixture.metadata",
  name: "Fixture Metadata",
  version: "1.0.0",
  types: ["series"],
  resources: ["catalog", { name: "meta", types: ["series"] }],
  catalogs: [
    { id: "movies", type: "movie", extra: [{ name: "search" }] },
    {
      id: "series-search",
      type: "series",
      extra: [{ name: "search", isRequired: true }, { name: "skip" }],
    },
  ],
};

describe("generic Stremio metadata protocol", () => {
  it.each([
    "file:///tmp/manifest.json",
    "https://user:password@example.test/manifest.json",
    "https://example.test/addon.json",
    "not a URL",
  ])("rejects unsafe or malformed manifest URL %j", (manifestUrl) => {
    expect(() => new MetadataStremioClient({ manifestUrl })).toThrow(
      MetadataStremioConfigurationError,
    );
  });

  it("selects and calls a nested authenticated series search catalog", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            metas: [{ id: "opaque:id", type: "series", name: "Fixture" }],
          }),
        ),
      );
    const client = new MetadataStremioClient(
      {
        manifestUrl:
          "https://metadata.test/user/token/manifest.json?key=secret",
        manifestCacheTtlMs: 0,
        catalogCacheTtlMs: 0,
      },
      fetcher,
    );
    expect(await client.searchSeries("anime tv", 20)).toEqual([
      { id: "opaque:id", type: "series", name: "Fixture" },
    ]);
    const requested = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(requested.pathname).toBe(
      "/user/token/catalog/series/series-search/search=anime%20tv&skip=20.json",
    );
    expect(requested.search).toBe("?key=secret");
    expect(client.safeOrigin).toBe("https://metadata.test");
  });

  it("keeps exact opaque episode IDs and filters malformed videos", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            meta: {
              id: "opaque:series/α",
              type: "series",
              name: "Fixture",
              runtime: "24 min",
              videos: [
                { id: "opaque:episode:exact:1", season: 1, episode: 1 },
                { id: "bad", season: 1, episode: 0 },
              ],
            },
          }),
        ),
      );
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        metaCacheTtlMs: 0,
      },
      fetcher,
    );
    const meta = await client.getSeriesMeta("opaque:series/α");
    expect(meta.runtimeSeconds).toBe(1440);
    expect(meta.videos).toEqual([
      { id: "opaque:episode:exact:1", season: 1, episode: 1 },
    ]);
  });

  it("caches catalog and meta responses without changing opaque IDs", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("manifest.json")) {
        return new Response(JSON.stringify(manifest));
      }
      if (url.pathname.includes("/catalog/")) {
        return new Response(
          JSON.stringify({
            metas: [{ id: "opaque:cached", type: "series", name: "Cached" }],
          }),
        );
      }
      return new Response(
        JSON.stringify({
          meta: {
            id: "opaque:cached",
            type: "series",
            name: "Cached",
            videos: [{ id: "opaque:episode", season: 1, episode: 1 }],
          },
        }),
      );
    });
    const client = new MetadataStremioClient(
      { manifestUrl: "https://metadata.test/manifest.json" },
      fetcher,
    );
    await client.searchSeries("cached");
    await client.searchSeries("cached");
    await client.getSeriesMeta("opaque:cached");
    await client.getSeriesMeta("opaque:cached");
    expect(client.stats).toEqual({
      manifestRequests: 1,
      catalogRequests: 1,
      metaRequests: 1,
    });
  });

  it("requires a declared searchable series catalog", () => {
    expect(() =>
      parseMetadataManifest({
        ...manifest,
        catalogs: [{ id: "x", type: "series" }],
      }),
    ).not.toThrow();
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        searchCatalogId: "missing",
      },
      async () => new Response(JSON.stringify(manifest)),
    );
    return expect(client.getManifest()).rejects.toBeInstanceOf(
      MetadataStremioCompatibilityError,
    );
  });

  it("derives resource paths without losing a nested addon prefix", () => {
    const url = deriveStremioResourceUrl(
      new URL("https://example.test/config/token/manifest.json?auth=x"),
      ["meta", "series", "opaque:id/part"],
    );
    expect(url.href).toBe(
      "https://example.test/config/token/meta/series/opaque%3Aid%2Fpart.json?auth=x",
    );
  });
});

describe("virtual Stremio IDs", () => {
  it.each(["tt1234567", "opaque:series/α?x=1", "空 白"])(
    "round trips arbitrary source ID %j",
    (sourceId) => {
      expect(parseVirtualMetaId(createVirtualMetaId(sourceId))).toEqual({
        sourceId,
      });
      expect(
        parseVirtualVideoId(createVirtualVideoId(sourceId, 2, 4, 6)),
      ).toEqual({
        sourceId,
        season: 2,
        firstEpisode: 4,
        lastEpisode: 6,
      });
    },
  );

  it("keeps legacy TV IDs stable and round trips long-form IDs", async () => {
    const ids = await import("../src/virtual-ids.js");
    expect(ids.createVirtualMetaId("test")).toBe("atc:tv:dGVzdA");
    expect(ids.createVirtualVideoId("test", 1, 1, 3)).toBe(
      "atc:tv:dGVzdA:s1:e1-3",
    );
    const season = ids.createSeasonCutVideoId("test", 2, 1, 12);
    expect(ids.parseSeasonCutVideoId(season)).toMatchObject({
      mode: "season",
      sourceId: "test",
      season: 2,
      firstEpisode: 1,
      lastEpisode: 12,
    });
    const series = ids.createSeriesCutVideoId("test", [
      { id: "opaque", season: 1, episode: 1 },
    ]);
    expect(ids.parseSeriesCutVideoId(series)).toMatchObject({
      mode: "series",
      sourceId: "test",
    });
    expect(
      ids.parseLongFormVirtualMetaId(
        ids.createLongFormVirtualMetaId("series", "test"),
      ),
    ).toEqual({ mode: "series", sourceId: "test" });
  });

  it("changes Complete Cut version when the ordered episode set changes", async () => {
    const { createSeriesCutVersion } = await import("../src/virtual-ids.js");
    const v1 = createSeriesCutVersion([{ id: "s1e1", season: 1, episode: 1 }]);
    const v2 = createSeriesCutVersion([
      { id: "s1e1", season: 1, episode: 1 },
      { id: "s2e1", season: 2, episode: 1 },
    ]);
    expect(v1).not.toBe(v2);
  });

  it.each(["tt123", "atc:tv:dGVzdA:s1:e4-2", "atc:tv:dGVzdA:s1:e1-99"])(
    "rejects malformed or over-broad video ID %j",
    (value) => {
      expect(() => parseVirtualVideoId(value)).toThrow();
    },
  );
});
