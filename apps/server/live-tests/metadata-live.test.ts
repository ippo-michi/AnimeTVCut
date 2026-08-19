import { describe, expect, it, vi } from "vitest";

import { groupTvCutEpisodes } from "@animetvcut/core";
import {
  MetadataStremioClient,
  createVirtualMetaId,
  createVirtualVideoId,
  parseVirtualMetaId,
  parseVirtualVideoId,
} from "@animetvcut/stremio";

import { createApp } from "../src/app.js";
import type { EpisodeWatchProgressReporter } from "../src/services/watch-progress.js";

interface LiveTarget {
  name: string;
  manifestUrl: string;
  query: string;
  sourceId?: string;
}

const targets: LiveTarget[] = [
  {
    name: "AIOMetadata",
    manifestUrl: process.env.AIOMETADATA_TEST_MANIFEST_URL ?? "",
    query: process.env.AIOMETADATA_TEST_SEARCH ?? "One Piece",
    sourceId: process.env.AIOMETADATA_TEST_SOURCE_ID,
  },
  {
    name: "Cinemeta-compatible",
    manifestUrl: process.env.CINEMETA_TEST_MANIFEST_URL ?? "",
    query: process.env.CINEMETA_TEST_QUERY ?? "One Piece",
    sourceId: process.env.CINEMETA_TEST_SOURCE_ID,
  },
].filter((target) => target.manifestUrl.length > 0);

describe.skipIf(targets.length === 0)(
  "optional live Stremio metadata addons",
  () => {
    for (const target of targets) {
      it(`validates and searches ${target.name}`, async () => {
        const client = new MetadataStremioClient({
          manifestUrl: target.manifestUrl,
          requestTimeoutMs: 30_000,
          manifestCacheTtlMs: 0,
          catalogCacheTtlMs: 0,
          metaCacheTtlMs: 0,
        });
        const manifest = await client.getManifest();
        expect(manifest.types).toContain("series");
        expect((await client.getSearchCatalog()).type).toBe("series");
        const results = await client.searchSeries(target.query);
        expect(Array.isArray(results)).toBe(true);
        const sourceId = target.sourceId ?? results[0]?.id;
        if (sourceId !== undefined) {
          const meta = await client.getSeriesMeta(sourceId);
          expect(meta.id).toBe(sourceId);
          expect(meta.videos).toBeInstanceOf(Array);
          const grouping = groupTvCutEpisodes(
            meta.videos.map((episode) => ({
              sourceId: episode.id,
              season: episode.season,
              episode: episode.episode,
              ...(episode.released === undefined
                ? {}
                : { released: episode.released }),
              ...(meta.runtimeSeconds === undefined
                ? {}
                : { runtimeSeconds: meta.runtimeSeconds }),
            })),
          );
          expect(parseVirtualMetaId(createVirtualMetaId(meta.id))).toEqual({
            sourceId: meta.id,
          });
          const group = grouping.groups[0];
          if (group !== undefined) {
            const id = createVirtualVideoId(
              meta.id,
              group.season,
              group.firstEpisode,
              group.lastEpisode,
            );
            expect(parseVirtualVideoId(id).sourceId).toBe(meta.id);
          }
        }
      });
    }
  },
);

describe.skipIf(process.env.AIOMETADATA_TEST_MANIFEST_URL === undefined)(
  "optional live public catalog route",
  () => {
    it("serves a valid search catalog through /v2 with metadata counters", async () => {
      const client = new MetadataStremioClient({
        manifestUrl: process.env.AIOMETADATA_TEST_MANIFEST_URL ?? "",
        requestTimeoutMs: 30_000,
        manifestCacheTtlMs: 0,
        catalogCacheTtlMs: 0,
        metaCacheTtlMs: 0,
      });
      const reportEpisodeWatched = vi.fn<
        Parameters<EpisodeWatchProgressReporter["reportEpisodeWatched"]>,
        ReturnType<EpisodeWatchProgressReporter["reportEpisodeWatched"]>
      >(async () => "triggered");
      const reporter: EpisodeWatchProgressReporter = { reportEpisodeWatched };
      const app = createApp({
        metadataClient: client,
        publicBaseUrl: new URL("https://public.animetvcut.test"),
        watchProgressReporter: reporter,
      });
      try {
        const query = process.env.AIOMETADATA_TEST_SEARCH ?? "One Piece";
        const response = await app.inject({
          method: "GET",
          url: `/v2/catalog/series/animetvcut-v2/search=${encodeURIComponent(query)}.json`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("*");
        const metas = response.json().metas as { id: string }[];
        expect(Array.isArray(metas)).toBe(true);
        expect(metas.length).toBeGreaterThan(0);
        expect(
          metas.every((meta) => /^atc:(tv|season|series):/.test(meta.id)),
        ).toBe(true);
        const stats = client.stats;
        expect(stats.manifestRequests).toBeGreaterThanOrEqual(1);
        expect(stats.catalogRequests).toBeGreaterThanOrEqual(1);
        expect(reportEpisodeWatched).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("settles the Frieren -> other query -> Frieren sequence with meta follow-ups", async () => {
      // Production-like caching: second identical query and meta follow-ups
      // must be served from the client-side caches.
      const client = new MetadataStremioClient({
        manifestUrl: process.env.AIOMETADATA_TEST_MANIFEST_URL ?? "",
        requestTimeoutMs: 30_000,
      });
      const app = createApp({
        metadataClient: client,
        publicBaseUrl: new URL("https://public.animetvcut.test"),
        watchProgressReporter: {
          reportEpisodeWatched: async () => "triggered",
        },
      });
      try {
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
        const firstMetas = first.json().metas as { id: string; name: string }[];
        expect(firstMetas.length).toBeGreaterThan(0);
        const frierenIds = firstMetas.map((item) => item.id).sort();
        // The known Frieren catalog entry must produce the exact virtual ids.
        expect(frierenIds).toEqual([
          "atc:season:dHQyMjI0ODM3Ng",
          "atc:series:dHQyMjI0ODM3Ng",
          "atc:tv:dHQyMjI0ODM3Ng",
        ]);
        const statsAfterFirstCatalog = client.stats;
        expect(statsAfterFirstCatalog.manifestRequests).toBe(1);
        expect(statsAfterFirstCatalog.catalogRequests).toBe(1);

        for (const id of firstMetas.map((item) => item.id)) {
          const response = await meta(id);
          expect(response.statusCode).toBe(200);
          expect(response.json().meta.videos.length).toBeGreaterThan(0);
        }
        // Only the first meta fetch touches the metadata addon; the other
        // two cut modes share the same source series.
        expect(client.stats.metaRequests).toBe(1);

        const other = await catalog("One Piece");
        expect(other.statusCode).toBe(200);
        expect(client.stats.catalogRequests).toBe(2);

        const second = await catalog("Frieren");
        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual(first.json());
        // Second identical query is a cache hit; no new upstream requests.
        expect(client.stats).toEqual({
          manifestRequests: 1,
          catalogRequests: 2,
          metaRequests: 1,
        });

        for (const id of firstMetas.map((item) => item.id)) {
          const response = await meta(id);
          expect(response.statusCode).toBe(200);
          expect(response.json().meta.videos.length).toBeGreaterThan(0);
        }
        expect(client.stats).toEqual({
          manifestRequests: 1,
          catalogRequests: 2,
          metaRequests: 1,
        });
      } finally {
        await app.close();
      }
    });
  },
);
