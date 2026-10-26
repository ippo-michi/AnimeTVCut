import { Readable } from "node:stream";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("chapter preparation concurrency", () => {
  it("overlaps chapter reads within the configured budget and preserves episode order", async () => {
    let active = 0,
      peak = 0;
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerFinished = false;
    let overlappedProvider = false;
    const episodes = [1, 2, 3, 4].map((number) => ({
      episodeId: `ep${number}`,
      type: "series",
      videoId: `opaque:${number}`,
    }));
    const app = createApp({
      chapterProbeConcurrency: 2,
      skipProviders: [
        {
          name: "gated-provider",
          priority: 1,
          supports: () => true,
          getSegments: async () => {
            await providerGate;
            providerFinished = true;
            return {
              provider: "gated-provider",
              status: "not_found",
              segments: [],
              warnings: [],
            };
          },
        },
      ],
      sourceChapterReader: {
        read: async (source) => {
          if (!providerFinished) overlappedProvider = true;
          releaseProvider();
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) =>
            setTimeout(resolve, source.episodeId === "ep1" ? 30 : 5),
          );
          active -= 1;
          return [
            { title: "OP", start: 0, end: 30 },
            { title: "ED", start: 150, end: 180 },
          ];
        },
      },
      episodeSourceResolver: {
        resolve: async () => ({
          familyMethod: "binge_group",
          familyKey: "fixture-family",
          episodes: episodes.map((episode) => ({
            episodeId: episode.episodeId,
            upstreamType: episode.type,
            upstreamVideoId: episode.videoId,
            upstreamRank: 0,
            familyMethod: "binge_group",
            familyKey: "fixture-family",
            subtitles: [],
            mediaSource: {
              kind: "http_media",
              episodeId: episode.episodeId,
              url: `https://media.test/${episode.episodeId}.mkv`,
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
      },
      sourceLoader: {
        loadPlaylist: async () =>
          parseHlsVodPlaylist(
            "#EXTM3U\n#EXT-X-TARGETDURATION:180\n#EXTINF:180,\nsegment.ts\n#EXT-X-ENDLIST\n",
            "https://media.test/playlist.m3u8",
          ),
        createResource: () => ({
          contentType: "video/mp2t",
          open: async () => ({
            statusCode: 200,
            contentType: "video/mp2t",
            responseHeaders: {},
            stream: Readable.from([]),
          }),
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/dev/cuts/from-upstream/auto",
        payload: { episodes },
      });
      expect(response.statusCode).toBe(200);
      expect(peak).toBe(2);
      expect(overlappedProvider).toBe(true);
      expect(
        response
          .json()
          .pieces.map(
            (piece: { sourceEpisodeId: string }) => piece.sourceEpisodeId,
          ),
      ).toEqual(episodes.map((episode) => episode.episodeId));
      const stages = (await app.inject("/api/v1/dev/diagnostics")).json()
        .preparation;
      for (const stage of [
        "source_resolution",
        "playlist_preparation",
        "skip_lookup",
        "chapter_lookup",
      ])
        expect(stages[stage]).toMatchObject({ count: 1, failures: 0 });
    } finally {
      await app.close();
    }
  });
});
