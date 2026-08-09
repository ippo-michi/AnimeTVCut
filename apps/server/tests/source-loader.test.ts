import path from "node:path";

import { describe, expect, it } from "vitest";

import { FixtureSourceLoader } from "../src/services/fixture-source.js";
import type { HlsSourceLoader } from "../src/services/hls-source-loader.js";

describe("HlsSourceLoader fixture implementation", () => {
  it("loads playlists and resolves typed resources through the transport seam", async () => {
    const loader: HlsSourceLoader = new FixtureSourceLoader(path.resolve("fixtures/hls"));
    const source = {
      episodeId: "ep1",
      playlistUrl: "fixture://fmp4-episode1",
    };
    const playlist = await loader.loadPlaylist(source);
    const segment = playlist.segments[0];
    if (segment === undefined) {
      throw new Error("Fixture playlist has no segment");
    }
    const resolved = await loader.resolveResource({
      source,
      resource: {
        id: "opaque.m4s",
        sourceEpisodeId: "ep1",
        absoluteUri: segment.absoluteUri,
        kind: "segment",
        mediaFormat: segment.mediaFormat,
        contentType: segment.contentType,
      },
    });
    expect(resolved.contentType).toBe("video/mp4");
    expect(resolved.contentLength).toBeGreaterThan(0);
    const stream = resolved.open({ start: 0, end: 15 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks)).toHaveLength(16);
  });
});
