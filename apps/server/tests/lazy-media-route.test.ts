import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type {
  HlsSourceLoader,
  MediaReadRange,
} from "../src/services/hls-source-loader.js";

function testLoader(open: ReturnType<typeof vi.fn>): HlsSourceLoader {
  return {
    loadPlaylist: async () => ({
      sourceUrl: "fixture://lazy/playlist.m3u8",
      targetDuration: 6,
      mediaSequence: 0,
      duration: 6,
      independentSegments: true,
      segments: [
        {
          index: 0,
          uri: "segment.ts",
          absoluteUri: "fixture://lazy/segment.ts",
          duration: 6,
          title: "",
          start: 0,
          end: 6,
          discontinuityBefore: false,
          mediaFormat: "mpegts",
          contentType: "video/mp2t",
          safeExtension: ".ts",
        },
      ],
    }),
    createResource: () => ({ contentType: "video/mp2t", open }),
  };
}

function prefetchLoader(open: ReturnType<typeof vi.fn>): HlsSourceLoader {
  return {
    loadPlaylist: async () => ({
      sourceUrl: "fixture://prefetch/playlist.m3u8",
      targetDuration: 2,
      mediaSequence: 0,
      duration: 6,
      independentSegments: true,
      segments: Array.from({ length: 3 }, (_, index) => ({
        index,
        uri: `segment-${index}.ts`,
        absoluteUri: `fixture://prefetch/segment-${index}.ts`,
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
      open: async () => {
        open(resource.absoluteUri);
        return {
          statusCode: 200 as const,
          contentType: resource.contentType,
          contentLength: 5,
          responseHeaders: { "content-length": "5" },
          stream: Readable.from(Buffer.from("media")),
        };
      },
    }),
  };
}

describe("lazy media route", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createCut(open: ReturnType<typeof vi.fn>) {
    const app = createApp({ sourceLoader: testLoader(open) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [
          {
            kind: "fixture_hls",
            episodeId: "ep1",
            playlistUrl: "fixture://lazy",
          },
        ],
        remove: [],
      },
    });
    expect(response.statusCode).toBe(200);
    const playlistResponse = await app.inject({
      method: "GET",
      url: (response.json() as { playlistUrl: string }).playlistUrl,
    });
    const resourcePath = playlistResponse.body
      .split("\n")
      .find(
        (line) => line.startsWith("/media/cut/") && line.includes("/segment/"),
      );
    if (resourcePath === undefined)
      throw new Error("No resource in test playlist");
    return { app, resourcePath };
  }

  it("does not open a resource while creating a cut", async () => {
    const open = vi.fn();
    await createCut(open);
    expect(open).not.toHaveBeenCalled();
  });

  it("streams an unknown-length 200 and filters unsafe headers", async () => {
    const open = vi.fn(async () => ({
      statusCode: 200 as const,
      contentType: "video/mp2t",
      responseHeaders: {
        "cache-control": "public, max-age=60",
        "set-cookie": "secret=value",
        connection: "keep-alive",
      },
      stream: Readable.from(Buffer.from("media")),
    }));
    const { app, resourcePath } = await createCut(open);
    const response = await app.inject({ method: "GET", url: resourcePath });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("media");
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("passes an open-ended range to a lazy resource and relays 206", async () => {
    const open = vi.fn(async (range?: MediaReadRange) => {
      expect(range).toEqual({ start: 10 });
      return {
        statusCode: 206 as const,
        contentType: "video/mp2t",
        contentLength: 3,
        responseHeaders: {
          "accept-ranges": "bytes",
          "content-length": "3",
          "content-range": "bytes 10-12/20",
        },
        stream: Readable.from(Buffer.from("abc")),
      };
    });
    const { app, resourcePath } = await createCut(open);
    const response = await app.inject({
      method: "GET",
      url: resourcePath,
      headers: { range: "bytes=10-" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 10-12/20");
    expect(response.body).toBe("abc");
  });

  it("warms only bounded lookahead resources after playback starts", async () => {
    const open = vi.fn();
    const app = createApp({
      sourceLoader: prefetchLoader(open),
      mediaPrefetchResources: 2,
    });
    apps.push(app);
    const cut = await app.inject({
      method: "POST",
      url: "/api/v1/dev/cuts",
      payload: {
        sources: [
          {
            kind: "fixture_hls",
            episodeId: "ep1",
            playlistUrl: "fixture://prefetch",
          },
        ],
        remove: [],
      },
    });
    expect(open).not.toHaveBeenCalled();
    const playlist = await app.inject({
      method: "GET",
      url: (cut.json() as { playlistUrl: string }).playlistUrl,
    });
    expect(open).not.toHaveBeenCalled();
    const resourcePaths = playlist.body
      .split("\n")
      .filter((line) => line.startsWith("/media/cut/") && line.endsWith(".ts"));
    expect(resourcePaths).toHaveLength(3);

    const response = await app.inject({
      method: "GET",
      url: resourcePaths[0]!,
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    expect(open).toHaveBeenNthCalledWith(1, "fixture://prefetch/segment-0.ts");
    expect(open).toHaveBeenNthCalledWith(2, "fixture://prefetch/segment-1.ts");
    expect(open).toHaveBeenNthCalledWith(3, "fixture://prefetch/segment-2.ts");
  });
});
