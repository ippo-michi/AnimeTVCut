import { describe, expect, it } from "vitest";

import { groupTvCutEpisodes } from "@animetvcut/core";
import {
  MetadataStremioClient,
  createVirtualMetaId,
  createVirtualVideoId,
  parseVirtualMetaId,
  parseVirtualVideoId,
} from "@animetvcut/stremio";

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
