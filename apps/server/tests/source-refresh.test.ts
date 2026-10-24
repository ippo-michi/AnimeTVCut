import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseHlsVodPlaylist } from "@animetvcut/hls";
import { describe, expect, it, vi } from "vitest";

import type {
  HlsSourceLoader,
  HttpMediaSource,
} from "../src/services/hls-source-loader.js";
import { RecoverableSourceLoader } from "../src/services/recoverable-source-loader.js";
import { MediaFlowSourceError } from "../src/services/mediaflow/errors.js";
import type { StremioUpstreamClient } from "../src/services/stremio-upstream/client.js";
import { SessionPersistence } from "../src/services/session-persistence.js";
import { CutSessionStore } from "../src/services/cut-session-store.js";
import { CutService } from "../src/services/cut-service.js";

function setup(changedTimeline = false, wrongRelease = false) {
  const playlist = (fresh: boolean) =>
    parseHlsVodPlaylist(
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:${fresh && changedTimeline ? 5 : 6},\nsegment.ts?token=${fresh ? "fresh" : "old"}\n#EXT-X-ENDLIST\n`,
      "http://normalizer.test/playlist.m3u8",
    );
  const getStreams = vi.fn(async () => [
    {
      kind: "url",
      filename: wrongRelease ? "other.mkv" : "episode.mkv",
      videoSize: 1234,
      url: "https://origin.test/fresh",
      requestHeaders: {},
    },
  ]);
  const base: HlsSourceLoader = {
    loadPlaylist: async (source) =>
      playlist(source.kind === "http_media" && source.url.endsWith("fresh")),
    createResource: ({ resource }) => ({
      contentType: resource.contentType,
      open: async () => {
        if (resource.absoluteUri.includes("token=old"))
          throw new MediaFlowSourceError("Expired source");
        return {
          statusCode: 200,
          contentType: resource.contentType,
          responseHeaders: {},
          stream: Readable.from(["video"]),
        };
      },
    }),
  };
  const changed = vi.fn();
  const loader = new RecoverableSourceLoader(
    base,
    { getStreams } as unknown as StremioUpstreamClient,
    changed,
  );
  const source: HttpMediaSource = {
    kind: "http_media",
    episodeId: "ep1",
    url: "https://origin.test/old",
    recovery: {
      type: "series",
      videoId: "opaque:ep1",
      filename: "episode.mkv",
      videoSize: 1234,
    },
  };
  return { loader, source, getStreams, changed, base };
}

describe("verified source URL recovery", () => {
  it("recovers an expired URL after restart and persists the replacement without rebuilding the cut", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "atc-refresh-"));
    const { loader, source, base, getStreams } = setup();
    try {
      const initial = new CutSessionStore({
        persistence: new SessionPersistence(directory, loader),
      });
      const service = new CutService(loader, initial);
      const cut = await service.createCut({ sources: [source], remove: [] });
      service.enableWatchProgress(cut.cutId, ["ep1"]);
      initial
        .get(cut.cutId)!
        .watchProgress!.triggeredSourceEpisodeIds.add("ep1");
      initial.attachSubtitles(
        cut.cutId,
        [
          {
            id: "track",
            lang: "eng",
            familyMethod: "exact_id",
            outputFormat: "webvtt",
            state: "ready",
            cached: new Uint8Array([1, 2]),
            sources: [],
          },
        ],
        { discoveredPerEpisode: {}, issues: [] },
      );
      initial.close();
      loader.close();
      const recovered = new RecoverableSourceLoader(
        base,
        { getStreams } as unknown as StremioUpstreamClient,
        () => restored.checkpointAll(),
      );
      const restored = new CutSessionStore({
        persistence: new SessionPersistence(directory, recovered),
      });
      const session = restored.get(cut.cutId)!;
      expect(session.playlist).toBe(initial.get(cut.cutId)!.playlist);
      expect(session.watchProgress!.triggeredSourceEpisodeIds.has("ep1")).toBe(
        true,
      );
      expect(session.subtitleTracks.get("track")?.state).toBe("lazy");
      expect(session.subtitleTracks.get("track")?.cached).toBeUndefined();
      const resource = [...session.resources.values()][0]!;
      (await resource.open()).stream.destroy();
      expect(getStreams).toHaveBeenCalledOnce();
      recovered.close();
      const final = new CutSessionStore({
        persistence: new SessionPersistence(
          directory,
          new RecoverableSourceLoader(base),
        ),
      });
      const finalResource = final.get(cut.cutId)!.resources.get(resource.id)!;
      (await finalResource.open()).stream.destroy();
      expect(getStreams).toHaveBeenCalledOnce();
      final.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("coalesces expiry recovery and preserves a segment's exact placement", async () => {
    const { loader, source, getStreams, changed } = setup();
    const playlist = await loader.loadPlaylist(source);
    const descriptor = {
      id: "r1",
      sourceEpisodeId: "ep1",
      kind: "segment" as const,
      mediaFormat: "mpegts" as const,
      contentType: "video/mp2t",
      absoluteUri: playlist.segments[0]!.absoluteUri,
      sourceStart: 1,
      sourceEnd: 4,
      outputStart: 30,
    };
    const resource = loader.createResource({ source, resource: descriptor });
    const opened = await Promise.all([resource.open(), resource.open()]);
    expect(getStreams).toHaveBeenCalledOnce();
    expect(getStreams.mock.calls[0]).toMatchObject([
      { videoId: "opaque:ep1" },
      expect.any(AbortSignal),
      true,
    ]);
    expect(descriptor).toMatchObject({
      sourceStart: 1,
      sourceEnd: 4,
      outputStart: 30,
    });
    expect(descriptor.absoluteUri).toContain("token=fresh");
    expect(changed).toHaveBeenCalledOnce();
    opened.forEach(({ stream }) => stream.destroy());
    loader.close();
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    "rejects a changed timeline or release (%s, %s)",
    async (changedTimeline, wrongRelease) => {
      const { loader, source, changed } = setup(changedTimeline, wrongRelease);
      const playlist = await loader.loadPlaylist(source);
      const resource = loader.createResource({
        source,
        resource: {
          id: "r1",
          sourceEpisodeId: "ep1",
          kind: "segment",
          mediaFormat: "mpegts",
          contentType: "video/mp2t",
          absoluteUri: playlist.segments[0]!.absoluteUri,
        },
      });
      await expect(resource.open()).rejects.toBeInstanceOf(
        MediaFlowSourceError,
      );
      expect(source.url).toBe("https://origin.test/old");
      expect(changed).not.toHaveBeenCalled();
      loader.close();
    },
  );
});
