import { Readable } from "node:stream";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MetadataStremioClient } from "@animetvcut/stremio";

import { mediaRoutes } from "../src/routes/media.js";
import { CutService } from "../src/services/cut-service.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import type {
  HlsSourceLoader,
  MediaReadRange,
} from "../src/services/hls-source-loader.js";
import {
  AiometadataWatchProgressReporter,
  CutWatchProgressTracker,
  type EpisodeWatchProgressReporter,
} from "../src/services/watch-progress.js";

const episodeIds = [1, 2, 3].map((episode) => `kitsu:46170:${episode}`);

function metadataClient(
  manifest: Record<string, unknown>,
  manifestUrl = "https://metadata.test/stremio/private-user/manifest.json?api_key=secret",
): MetadataStremioClient {
  return new MetadataStremioClient(
    { manifestUrl, manifestCacheTtlMs: 60_000 },
    async () => new Response(JSON.stringify(manifest)),
  );
}

const aiometadataManifest = {
  id: "aio-metadata",
  name: "AIOMetadata",
  version: "2.12.0",
  types: ["series"],
  resources: ["catalog", "meta", "subtitles"],
  catalogs: [
    {
      id: "anime",
      type: "series",
      extra: [{ name: "search", isRequired: true }],
    },
  ],
};

function mediaLoader(
  opened?: (uri: string, range?: MediaReadRange) => void,
): HlsSourceLoader {
  return {
    loadPlaylist: async (source) => ({
      sourceUrl: `fixture://${source.episodeId}/playlist.m3u8`,
      targetDuration: 2,
      mediaSequence: 0,
      duration: 6,
      independentSegments: true,
      segments: Array.from({ length: 3 }, (_, index) => ({
        index,
        uri: `segment-${index}.ts`,
        absoluteUri: `fixture://${encodeURIComponent(source.episodeId)}/segment-${index}.ts`,
        duration: 2,
        title: "",
        start: index * 2,
        end: (index + 1) * 2,
        discontinuityBefore: false,
        mediaFormat: "mpegts" as const,
        contentType: "video/mp2t",
        safeExtension: ".ts" as const,
      })),
    }),
    createResource: ({ resource }) => ({
      contentType: resource.contentType,
      open: async (range) => {
        opened?.(resource.absoluteUri, range);
        const partial = range !== undefined;
        return {
          statusCode: partial ? (206 as const) : (200 as const),
          contentType: resource.contentType,
          contentLength: partial ? 2 : 5,
          responseHeaders: partial
            ? {
                "content-length": "2",
                "content-range": "bytes 1-2/5",
              }
            : { "content-length": "5" },
          stream: Readable.from(Buffer.from(partial ? "ed" : "media")),
        };
      },
    }),
  };
}

describe("AIOMetadata watch-progress reporter", () => {
  it("uses the authenticated manifest path without exposing it publicly", async () => {
    const requests: URL[] = [];
    const reporter = new AiometadataWatchProgressReporter(
      metadataClient(aiometadataManifest),
      async (input) => {
        requests.push(new URL(String(input)));
        return new Response(JSON.stringify({ subtitles: [] }));
      },
    );

    await expect(reporter.reportEpisodeWatched(episodeIds[2]!)).resolves.toBe(
      "triggered",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.origin).toBe("https://metadata.test");
    expect(requests[0]!.pathname).toBe(
      "/stremio/private-user/subtitles/series/kitsu%3A46170%3A3.json",
    );
    expect(requests[0]!.searchParams.get("api_key")).toBe("secret");
  });

  it("does not call a non-AIOMetadata or subtitle-incompatible addon", async () => {
    const trackingFetch = vi.fn();
    const reporter = new AiometadataWatchProgressReporter(
      metadataClient({
        ...aiometadataManifest,
        id: "fixture.metadata",
        name: "Fixture Metadata",
      }),
      trackingFetch,
    );

    await expect(reporter.reportEpisodeWatched(episodeIds[0]!)).resolves.toBe(
      "unsupported",
    );
    expect(trackingFetch).not.toHaveBeenCalled();
  });

  it("classifies HTTP and network failures without leaking request details", async () => {
    const reporter = new AiometadataWatchProgressReporter(
      metadataClient(aiometadataManifest),
      async () => new Response("denied", { status: 403 }),
    );
    await expect(reporter.reportEpisodeWatched(episodeIds[0]!)).resolves.toBe(
      "failed",
    );
  });
});

describe("cut watch-progress tracking", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function trackedCut(
    reporter: EpisodeWatchProgressReporter,
    options: {
      prefetch?: number;
      enable?: boolean;
      remove?: readonly {
        episodeId: string;
        start: number;
        end: number;
        type: "ending";
      }[];
      opened?: (uri: string, range?: MediaReadRange) => void;
    } = {},
  ) {
    const sessions = new CutSessionStore();
    const cuts = new CutService(mediaLoader(options.opened), sessions);
    const cut = await cuts.createCut({
      sources: episodeIds.map((episodeId) => ({
        kind: "fixture_hls" as const,
        episodeId,
        playlistUrl: `fixture://${episodeId}`,
      })),
      remove: [...(options.remove ?? [])],
    });
    if (options.enable !== false)
      cuts.enableWatchProgress(cut.cutId, episodeIds);
    const app = Fastify();
    apps.push(app);
    await app.register(
      mediaRoutes(
        sessions,
        undefined,
        options.prefetch ?? 0,
        new CutWatchProgressTracker(reporter),
      ),
    );
    const playlist = await app.inject({ method: "GET", url: cut.playlistUrl });
    const resources = playlist.body
      .split("\n")
      .filter((line) => line.startsWith("/media/cut/") && line.endsWith(".ts"));
    return { app, cut, resources };
  }

  it("reports each source episode only after its final retained segment", async () => {
    const reportEpisodeWatched = vi.fn(async () => "triggered" as const);
    const { app, resources } = await trackedCut({ reportEpisodeWatched });
    expect(reportEpisodeWatched).not.toHaveBeenCalled();

    await app.inject({ method: "GET", url: resources[0]! });
    expect(reportEpisodeWatched).not.toHaveBeenCalled();
    await app.inject({ method: "GET", url: resources[2]! });
    await vi.waitFor(() =>
      expect(reportEpisodeWatched).toHaveBeenCalledWith(episodeIds[0]),
    );
    await app.inject({ method: "GET", url: resources[2]! });
    expect(reportEpisodeWatched).toHaveBeenCalledTimes(1);

    await app.inject({ method: "GET", url: resources[5]! });
    await app.inject({ method: "GET", url: resources[8]! });
    await vi.waitFor(() =>
      expect(reportEpisodeWatched).toHaveBeenCalledTimes(3),
    );
    expect(reportEpisodeWatched.mock.calls.map(([id]) => id)).toEqual(
      episodeIds,
    );
  });

  it("uses the actual retained timeline when an ending is removed", async () => {
    const reportEpisodeWatched = vi.fn(async () => "triggered" as const);
    const { app, resources } = await trackedCut(
      { reportEpisodeWatched },
      {
        remove: [
          {
            episodeId: episodeIds[0]!,
            start: 4,
            end: 6,
            type: "ending",
          },
        ],
      },
    );
    expect(resources).toHaveLength(8);
    await app.inject({ method: "GET", url: resources[1]! });
    await vi.waitFor(() =>
      expect(reportEpisodeWatched).toHaveBeenCalledWith(episodeIds[0]),
    );
  });

  it("does not let server lookahead prefetch report an episode", async () => {
    const opened = vi.fn();
    const reportEpisodeWatched = vi.fn(async () => "triggered" as const);
    const { app, resources } = await trackedCut(
      { reportEpisodeWatched },
      { prefetch: 1, opened },
    );
    await app.inject({ method: "GET", url: resources[1]! });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
    expect(reportEpisodeWatched).not.toHaveBeenCalled();

    await app.inject({ method: "GET", url: resources[2]! });
    await vi.waitFor(() =>
      expect(reportEpisodeWatched).toHaveBeenCalledTimes(1),
    );
  });

  it("ignores partial range, manual-cut, and invalid resource requests", async () => {
    const reportEpisodeWatched = vi.fn(async () => "triggered" as const);
    const tracked = await trackedCut({ reportEpisodeWatched });
    await tracked.app.inject({
      method: "GET",
      url: tracked.resources[2]!,
      headers: { range: "bytes=1-2" },
    });
    await tracked.app.inject({
      method: "GET",
      url: `/media/cut/${tracked.cut.cutId}/segment/missing.ts`,
    });
    expect(reportEpisodeWatched).not.toHaveBeenCalled();

    const manual = await trackedCut(
      { reportEpisodeWatched },
      { enable: false },
    );
    await manual.app.inject({ method: "GET", url: manual.resources[2]! });
    expect(reportEpisodeWatched).not.toHaveBeenCalled();
  });

  it("coalesces concurrent triggers and isolates reporter failure", async () => {
    let resolve!: (result: "triggered") => void;
    const pending = new Promise<"triggered">((done) => {
      resolve = done;
    });
    const reportEpisodeWatched = vi.fn(() => pending);
    const { app, resources } = await trackedCut({ reportEpisodeWatched });
    const first = await app.inject({ method: "GET", url: resources[2]! });
    const second = await app.inject({ method: "GET", url: resources[2]! });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(reportEpisodeWatched).toHaveBeenCalledTimes(1);
    resolve("triggered");
    await vi.waitFor(() =>
      expect(reportEpisodeWatched).toHaveBeenCalledTimes(1),
    );

    const failing = await trackedCut({
      reportEpisodeWatched: async () => {
        throw new Error("private upstream failure");
      },
    });
    const media = await failing.app.inject({
      method: "GET",
      url: failing.resources[2]!,
    });
    expect(media.statusCode).toBe(200);
    expect(media.body).toBe("media");
  });
});
