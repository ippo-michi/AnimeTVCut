import { Readable } from "node:stream";

import { AniSkipProvider } from "@animetvcut/skip-providers";
import { parseHlsVodPlaylist } from "@animetvcut/hls";
import {
  MetadataStremioClient,
  createSeasonCutVideoId,
  createSeriesCutVideoId,
  createVirtualVideoId,
} from "@animetvcut/stremio";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { HlsSourceLoader } from "../src/services/hls-source-loader.js";
import { StremioEpisodeSourceResolver } from "../src/services/stremio-upstream/resolver.js";
import type { SourceChapterReader } from "../src/services/source-chapters.js";
import type { StremioUpstreamClient } from "../src/services/stremio-upstream/client.js";

function harness(chaptered = true) {
  const chapters = [
    { start: 0, end: 142.141, title: "Intro" },
    { start: 142.141, end: 232.023, title: "OP" },
    { start: 232.023, end: 1281.947, title: "Story" },
    { start: 1281.947, end: 1372.04, title: "ED" },
  ];
  const chapterReader: SourceChapterReader = {
    read: vi.fn(async (source, signal) => {
      signal?.throwIfAborted();
      return chaptered && source.url.includes("/bd/") ? chapters : [];
    }),
  };
  const getStreams = vi.fn(async (reference) => [
    {
      kind: "url",
      rank: 0,
      url: `https://media.test/bd/${reference.videoId}.mkv`,
      filename: "Idaten BD 1080p x265 FLAC.mkv",
      bingeGroup: "bd",
      requestHeaders: {},
      subtitles: [],
    },
    {
      kind: "url",
      rank: 1,
      url: `https://media.test/web/${reference.videoId}.mkv`,
      filename: "Idaten WEB-DL 1080p x264 AAC.mkv",
      bingeGroup: "web",
      requestHeaders: {},
      subtitles: [],
    },
  ]);
  const resolver = new StremioEpisodeSourceResolver(
    { getStreams } as unknown as StremioUpstreamClient,
    { chapterReader, retryDelayMs: 0 },
  );
  const sourceLoader: HlsSourceLoader = {
    loadPlaylist: async (source) => {
      const duration =
        source.kind === "http_media" && source.url.includes("/bd/")
          ? 1372.04
          : 1375.109;
      return parseHlsVodPlaylist(
        `#EXTM3U\n#EXT-X-TARGETDURATION:1376\n#EXTINF:${duration},\nepisode.ts\n#EXT-X-ENDLIST\n`,
        "https://media.test/playlist.m3u8",
      );
    },
    createResource: () => ({
      contentType: "video/mp2t",
      open: async () => ({
        statusCode: 200,
        contentType: "video/mp2t",
        responseHeaders: {},
        stream: Readable.from([]),
      }),
    }),
  };
  const provider = new AniSkipProvider({
    fetchImplementation: vi.fn(async (input) => {
      const episode = Number(new URL(String(input)).pathname.split("/").at(-1));
      return new Response(
        JSON.stringify(
          episode === 4
            ? { found: false }
            : {
                found: true,
                results: [
                  {
                    skipType: "op",
                    interval: { startTime: 40.824, endTime: 130.824 },
                  },
                  {
                    skipType: "ed",
                    interval: { startTime: 1281, endTime: 1371 },
                  },
                ],
              },
        ),
      );
    }),
  });
  const metadata = new MetadataStremioClient(
    { manifestUrl: "https://metadata.test/manifest.json" },
    async (input) => {
      if (String(input).endsWith("manifest.json"))
        return new Response(
          JSON.stringify({
            id: "fixture.metadata",
            name: "Metadata",
            version: "1.0.0",
            types: ["series"],
            resources: ["meta", "catalog"],
            catalogs: [
              { id: "search", type: "series", extra: [{ name: "search" }] },
            ],
          }),
        );
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt13409388",
            type: "series",
            name: "The Idaten Deities Know Only Peace",
            _malId: "42625",
            _kitsuId: "43734",
            runtime: "23 min",
            videos: Array.from({ length: 6 }, (_, i) => ({
              id: `kitsu:43734:${i + 1}`,
              season: 1,
              episode: i + 1,
              released: "2021-08-01T00:00:00Z",
            })),
          },
        }),
      );
    },
  );
  const app = createApp({
    metadataClient: metadata,
    episodeSourceResolver: resolver,
    sourceChapterReader: chapterReader,
    sourceLoader,
    skipProviders: [provider],
    publicBaseUrl: new URL("https://atc.test"),
    aiometadataWatchTracking: false,
  });
  return { app, getStreams, chapterReader };
}

describe("Idaten public playback regression", () => {
  it.each([
    {
      mode: "TV Cut",
      videoId: createVirtualVideoId("tt13409388", 1, 4, 6),
      count: 3,
    },
    {
      mode: "Season Cut",
      videoId: createSeasonCutVideoId("tt13409388", 1, 1, 6),
      count: 6,
    },
    {
      mode: "Complete Cut",
      videoId: createSeriesCutVideoId(
        "tt13409388",
        Array.from({ length: 6 }, (_, index) => ({
          id: `kitsu:43734:${index + 1}`,
          season: 1,
          episode: index + 1,
        })),
      ),
      count: 6,
    },
  ])(
    "recovers missing Idaten episode 4 skips in $mode using release-specific chapters",
    async ({ videoId, count }) => {
      const { app } = harness();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/v2/stream/series/${videoId}.json`,
        });
        expect(response.statusCode).toBe(200);
        const playlistUrl = new URL(
          response.json<{ streams: { url: string }[] }>().streams[0]!.url,
        );
        const cutId = playlistUrl.pathname.split("/")[3];
        const diagnostic = await app.inject({
          method: "GET",
          url: `/api/v1/dev/cuts/${cutId}/skip`,
        });
        expect(diagnostic.statusCode).toBe(200);
        const body = diagnostic.json();
        expect(body.warnings).toEqual([]);
        expect(body.episodes).toHaveLength(count);
        for (const episode of body.episodes) {
          expect(episode.segments).toHaveLength(2);
          expect(
            episode.segments.map(
              (segment: { provider: string }) => segment.provider,
            ),
          ).toEqual(["source-chapters", "source-chapters"]);
          expect(episode.segments[0]).toMatchObject({
            start: 142.141,
            end: 232.023,
          });
        }
        const timing = await app.inject({
          method: "GET",
          url: playlistUrl.pathname.replace("master.m3u8", "chapters.json"),
        });
        expect(timing.json().duration).toBeCloseTo(
          count * (1372.04 - (232.023 - 142.141) - (1372.04 - 1281.947)),
          3,
        );
        expect(diagnostic.body).not.toContain("https://media.test");
      } finally {
        await app.close();
      }
    },
  );

  it("keeps known skips and exposes missing coverage if no release has chapters", async () => {
    const { app, getStreams } = harness(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v2/stream/series/${createVirtualVideoId("tt13409388", 1, 4, 6)}.json`,
      });
      const cutId = new URL(
        response.json<{ streams: { url: string }[] }>().streams[0]!.url,
      ).pathname.split("/")[3];
      const diagnostic = await app.inject({
        method: "GET",
        url: `/api/v1/dev/cuts/${cutId}/skip`,
      });
      const body = diagnostic.json();
      expect(body.episodes[0].segments).toEqual([]);
      expect(body.episodes[1].segments).toHaveLength(2);
      expect(body.warnings).toEqual([
        "No verified opening skip range for kitsu:43734:4; retained source content.",
        "No verified ending skip range for kitsu:43734:4; retained source content.",
      ]);
      expect(getStreams).toHaveBeenCalledTimes(6);
    } finally {
      await app.close();
    }
  });
});
