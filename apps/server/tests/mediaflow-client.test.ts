import { describe, expect, it, vi } from "vitest";

import {
  MediaFlowClient,
  redactMediaFlowUrl,
} from "../src/services/mediaflow/client.js";
import { createMediaFlowConfig } from "../src/services/mediaflow/config.js";
import {
  MediaFlowAuthenticationError,
  MediaFlowConfigurationError,
  MediaFlowInvalidResponseError,
  MediaFlowUnavailableError,
} from "../src/services/mediaflow/errors.js";

const source = {
  kind: "http_media" as const,
  episodeId: "ep1",
  url: "http://fixture-origin:8090/episode1.mkv?signature=source-secret",
  headers: {
    Referer: "https://example.test/watch",
    Authorization: "Bearer source-secret",
    "X-Test-Token": "animetvcut-test",
  },
};

function mediaFlowPlaylist(
  resource = "/proxy/transcode/segment.m4s?id=1",
): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:6",
    '#EXT-X-MAP:URI="/proxy/transcode/init.mp4?id=1"',
    "#EXTINF:6.000000,",
    resource,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function mediaFlowMpegTsPlaylist(): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:6.000000,",
    "/proxy/transcode/segment.ts?id=1",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function fetchMock(
  implementation: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

describe("MediaFlow client", () => {
  it("constructs the transcode URL with encoded password and source headers", () => {
    const client = new MediaFlowClient({
      baseUrl: "http://mediaflow:8888/",
      apiPassword: "p&ss word",
    });
    const url = client.buildTranscodePlaylistUrl(source);
    expect(url.origin).toBe("http://mediaflow:8888");
    expect(url.pathname).toBe("/proxy/transcode/playlist.m3u8");
    expect(url.searchParams.get("d")).toBe(source.url);
    expect(url.searchParams.get("api_password")).toBe("p&ss word");
    expect(url.searchParams.get("h_Referer")).toBe(source.headers.Referer);
    expect(url.searchParams.get("h_Authorization")).toBe(
      source.headers.Authorization,
    );
    expect(url.searchParams.get("h_X-Test-Token")).toBe("animetvcut-test");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("requests and validates the seekable MPEG-TS passthrough mode", async () => {
    const mock = fetchMock(async (input) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("atc_container")).toBe("mpegts");
      return new Response(mediaFlowMpegTsPlaylist());
    });
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888", outputContainer: "mpegts" },
      mock,
    );
    const playlist = await client.loadTranscodePlaylist(source);
    expect(playlist.segments[0]).toMatchObject({
      mediaFormat: "mpegts",
      contentType: "video/mp2t",
    });
    expect(playlist.segments[0]).not.toHaveProperty("map");
  });

  it("places MPEG-TS timestamps on the virtual output timeline lazily", async () => {
    const mock = fetchMock(async (input) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get("atc_output_start_ms")).toBe("12345");
      return new Response(new Uint8Array([1]));
    });
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888", outputContainer: "mpegts" },
      mock,
    );
    const lazy = client.createLazyResource({
      id: "r1.ts",
      sourceEpisodeId: "ep2",
      absoluteUri: "http://mediaflow:8888/proxy/transcode/segment.ts?id=1",
      kind: "segment",
      mediaFormat: "mpegts",
      contentType: "video/mp2t",
      sourceStart: 300,
      outputStart: 12.345,
    });
    expect(mock).not.toHaveBeenCalled();
    await lazy.open();
    expect(mock).toHaveBeenCalledOnce();
  });

  it("redacts all sensitive query parameters", () => {
    expect(
      redactMediaFlowUrl(
        "http://mediaflow:8888/proxy/transcode/playlist.m3u8?api_password=secret&d=signed",
      ),
    ).toBe("http://mediaflow:8888/proxy/transcode/playlist.m3u8?<redacted>");
  });

  it.each([
    "file:///tmp/mediaflow",
    "http://user:password@mediaflow:8888",
    "http://mediaflow:8888/prefix",
  ])("rejects an invalid MediaFlow base URL: %s", (baseUrl) => {
    expect(() => createMediaFlowConfig({ baseUrl })).toThrow(
      MediaFlowConfigurationError,
    );
  });

  it("classifies authentication failures without exposing credentials", async () => {
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888", apiPassword: "do-not-leak" },
      fetchMock(async () => new Response("no", { status: 403 })),
    );
    await expect(client.loadTranscodePlaylist(source)).rejects.toEqual(
      new MediaFlowAuthenticationError(),
    );
    await expect(client.loadTranscodePlaylist(source)).rejects.not.toThrow(
      /do-not-leak|source-secret/,
    );
  });

  it("rejects a non-HLS MediaFlow response", async () => {
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888" },
      fetchMock(async () => new Response("<html>failed</html>")),
    );
    await expect(client.loadTranscodePlaylist(source)).rejects.toThrow(
      "MediaFlow returned an invalid HLS playlist.",
    );
  });

  it.each([
    ["another origin", "http://127.0.0.1/proxy/transcode/segment.m4s"],
    ["unapproved path", "/private/arbitrary-file"],
    ["file scheme", "file:///tmp/segment.m4s"],
  ])(
    "rejects a normalized playlist resource from %s",
    async (_label, resource) => {
      const client = new MediaFlowClient(
        { baseUrl: "http://mediaflow:8888" },
        fetchMock(
          async () =>
            new Response(mediaFlowPlaylist(resource), {
              headers: { "content-type": "application/vnd.apple.mpegurl" },
            }),
        ),
      );
      await expect(client.loadTranscodePlaylist(source)).rejects.toThrow(
        MediaFlowInvalidResponseError,
      );
    },
  );

  it("parses fMP4 and does not open maps or segments while loading the playlist", async () => {
    const mock = fetchMock(
      async () =>
        new Response(mediaFlowPlaylist(), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        }),
    );
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888" },
      mock,
    );
    const playlist = await client.loadTranscodePlaylist(source);
    expect(playlist.segments[0]).toMatchObject({
      mediaFormat: "fmp4",
      contentType: "video/mp4",
      map: { mediaFormat: "fmp4" },
    });
    expect(client.stats).toEqual({
      healthRequests: 0,
      playlistRequests: 1,
      resourceRequests: 0,
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("opens a remote 200 response lazily with unknown length", async () => {
    const mock = fetchMock(async () => new Response(new Uint8Array([1, 2, 3])));
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888" },
      mock,
    );
    const lazy = client.createLazyResource({
      id: "r1.m4s",
      sourceEpisodeId: "ep1",
      absoluteUri: "http://mediaflow:8888/proxy/transcode/segment.m4s?id=1",
      kind: "segment",
      mediaFormat: "fmp4",
      contentType: "video/mp4",
    });
    expect(mock).not.toHaveBeenCalled();
    const opened = await lazy.open();
    expect(opened.statusCode).toBe(200);
    expect(opened.contentLength).toBeUndefined();
    expect(client.stats.resourceRequests).toBe(1);
  });

  it("passes a byte range through and accepts a remote 206 response", async () => {
    const mock = fetchMock(async (_input, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=10-19");
      return new Response(new Uint8Array(10), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "10",
          "content-range": "bytes 10-19/100",
          "set-cookie": "must-not-pass",
        },
      });
    });
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888" },
      mock,
    );
    const lazy = client.createLazyResource({
      id: "r1.mp4",
      sourceEpisodeId: "ep1",
      absoluteUri: "http://mediaflow:8888/proxy/transcode/init.mp4?id=1",
      kind: "map",
      mediaFormat: "fmp4",
      contentType: "video/mp4",
    });
    const opened = await lazy.open({ start: 10, end: 19 });
    expect(opened).toMatchObject({
      statusCode: 206,
      contentLength: 10,
      responseHeaders: {
        "accept-ranges": "bytes",
        "content-length": "10",
        "content-range": "bytes 10-19/100",
      },
    });
    expect(opened.responseHeaders["set-cookie"]).toBeUndefined();
  });

  it("cancels an in-progress request through the caller signal", async () => {
    const mock = fetchMock(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          {
            once: true,
          },
        );
      });
      throw new Error("unreachable");
    });
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888" },
      mock,
    );
    const lazy = client.createLazyResource({
      id: "r1.m4s",
      sourceEpisodeId: "ep1",
      absoluteUri: "http://mediaflow:8888/proxy/transcode/segment.m4s?id=1",
      kind: "segment",
      mediaFormat: "fmp4",
      contentType: "video/mp4",
    });
    const controller = new AbortController();
    const opening = lazy.open(undefined, controller.signal);
    controller.abort();
    await expect(opening).rejects.toThrow(MediaFlowUnavailableError);
  });

  it("does not truncate an opened resource while a slow player consumes it", async () => {
    const mock = fetchMock(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            if (init?.signal?.aborted === true) {
              controller.error(new Error("absolute timeout truncated body"));
              return;
            }
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          }, 25);
        },
      });
      return new Response(body);
    });
    const client = new MediaFlowClient(
      { baseUrl: "http://mediaflow:8888", requestTimeoutMs: 5 },
      mock,
    );
    const opened = await client
      .createLazyResource({
        id: "r1.m4s",
        sourceEpisodeId: "ep1",
        absoluteUri: "http://mediaflow:8888/proxy/transcode/segment.m4s?id=1",
        kind: "segment",
        mediaFormat: "fmp4",
        contentType: "video/mp4",
      })
      .open();
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
  });
});
