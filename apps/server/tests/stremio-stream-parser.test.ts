import { describe, expect, it } from "vitest";

import {
  MAX_STREAM_CANDIDATES,
  parseStremioStreamResponse,
} from "../src/services/stremio-upstream/stream-parser.js";

describe("standard Stremio stream parsing", () => {
  it.each(["http://media.test/video.mkv", "https://media.test/video.m3u8"])(
    "accepts an HTTP(S) URL candidate: %s",
    (url) => {
      expect(
        parseStremioStreamResponse({ streams: [{ url }] })[0],
      ).toMatchObject({
        kind: "url",
        rank: 0,
        url,
      });
    },
  );

  it("preserves useful behavior hints and proxy request headers", () => {
    const [candidate] = parseStremioStreamResponse({
      streams: [
        {
          name: "AIOStreams 1080p",
          description: "formatter-independent display text",
          url: "https://media.test/video.mkv",
          behaviorHints: {
            filename: "Show.S01E01.1080p.WEB-DL-GROUP.mkv",
            videoSize: 123456789,
            bingeGroup: "family-A",
            notWebReady: true,
            proxyHeaders: {
              request: {
                Referer: "https://example.test/",
                Authorization: "Bearer secret",
                "X-Test-Token": "value",
              },
            },
            ignoredFutureHint: { any: "value" },
          },
        },
      ],
    });
    expect(candidate).toMatchObject({
      kind: "url",
      filename: "Show.S01E01.1080p.WEB-DL-GROUP.mkv",
      videoSize: 123456789,
      bingeGroup: "family-A",
      notWebReady: true,
      requestHeaders: {
        Referer: "https://example.test/",
        Authorization: "Bearer secret",
        "X-Test-Token": "value",
      },
    });
  });

  it.each([
    [{ infoHash: "abcdef" }, "torrent"],
    [{ nzbUrl: "https://usenet.test/file.nzb" }, "usenet"],
    [{ rarUrls: ["https://archive.test/a.rar"] }, "archive"],
    [{ zipUrls: ["https://archive.test/a.zip"] }, "archive"],
    [{ "7zipUrls": ["https://archive.test/a.7z"] }, "archive"],
    [{ ytId: "abc123" }, "youtube"],
    [{ externalUrl: "https://player.test" }, "external"],
  ])(
    "classifies unsupported standard stream shape %j as %s",
    (stream, kind) => {
      expect(
        parseStremioStreamResponse({ streams: [stream] })[0],
      ).toMatchObject({
        kind,
        rank: 0,
      });
    },
  );

  it.each([
    "ftp://media.test/video",
    "rtmp://media.test/video",
    "file:///tmp/a",
    "data:text/plain,a",
  ])("rejects unsupported URL protocol %s", (url) => {
    expect(parseStremioStreamResponse({ streams: [{ url }] })[0]).toMatchObject(
      {
        kind: "unsupported",
        reason: expect.stringContaining("protocol"),
      },
    );
  });

  it("rejects embedded URL credentials", () => {
    expect(
      parseStremioStreamResponse({
        streams: [{ url: "https://user:secret@media.test/video" }],
      })[0],
    ).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("embedded credentials"),
    });
  });

  it.each([
    "Host",
    "Content-Length",
    "Connection",
    "Transfer-Encoding",
    "Proxy-Authorization",
    "Upgrade",
    "TE",
    "Trailer",
  ])("rejects dangerous request header %s", (header) => {
    expect(
      parseStremioStreamResponse({
        streams: [
          {
            url: "https://media.test/video",
            behaviorHints: {
              proxyHeaders: { request: { [header]: "unsafe" } },
            },
          },
        ],
      })[0],
    ).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("headers"),
    });
  });

  it("rejects CRLF header injection", () => {
    expect(
      parseStremioStreamResponse({
        streams: [
          {
            url: "https://media.test/video",
            behaviorHints: {
              proxyHeaders: { request: { Referer: "ok\r\nHost: bad" } },
            },
          },
        ],
      })[0],
    ).toMatchObject({ kind: "unsupported" });
  });

  it("rejects malformed and oversized response collections", () => {
    expect(() => parseStremioStreamResponse({ streams: "no" })).toThrow(
      /streams array/,
    );
    expect(() =>
      parseStremioStreamResponse({
        streams: Array.from({ length: MAX_STREAM_CANDIDATES + 1 }, () => ({})),
      }),
    ).toThrow(/exceeds 200/);
  });
});
