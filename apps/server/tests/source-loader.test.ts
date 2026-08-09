import path from "node:path";

import { describe, expect, it } from "vitest";

import { FixtureSourceLoader } from "../src/services/fixture-source.js";
import { CutService } from "../src/services/cut-service.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import type { HlsSourceLoader } from "../src/services/hls-source-loader.js";

describe("HlsSourceLoader fixture implementation", () => {
  it("loads playlists and resolves typed resources through the transport seam", async () => {
    const loader: HlsSourceLoader = new FixtureSourceLoader(
      path.resolve("fixtures/hls"),
    );
    const source = {
      kind: "fixture_hls" as const,
      episodeId: "ep1",
      playlistUrl: "fixture://fmp4-episode1",
    };
    const playlist = await loader.loadPlaylist(source);
    const segment = playlist.segments[0];
    if (segment === undefined) {
      throw new Error("Fixture playlist has no segment");
    }
    const resolved = loader.createResource({
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
    const opened = await resolved.open({ start: 0, end: 15 });
    expect(opened.contentLength).toBe(16);
    const stream = opened.stream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    expect(Buffer.concat(chunks)).toHaveLength(16);
  });

  it("rejects long cuts that exceed segment or manifest safety bounds", async () => {
    const loader = new FixtureSourceLoader(path.resolve("fixtures/hls"));
    const service = new CutService(loader, new CutSessionStore());
    const prepared = await service.prepareSources([
      {
        kind: "fixture_hls",
        episodeId: "ep1",
        playlistUrl: "fixture://episode1",
      },
    ]);
    expect(() =>
      service.createCutFromPreparedSources({
        sources: prepared,
        remove: [],
        maxMediaSegments: 1,
      }),
    ).toThrow(/media segment limit/);
    expect(() =>
      service.createCutFromPreparedSources({
        sources: prepared,
        remove: [],
        maxManifestBytes: 32,
      }),
    ).toThrow(/manifest size limit/);
  });
});
