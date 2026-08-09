import { describe, expect, it } from "vitest";

import { StremioUpstreamClient } from "../src/services/stremio-upstream/client.js";
import { StremioEpisodeSourceResolver } from "../src/services/stremio-upstream/resolver.js";

const manifestUrl = process.env.AIOSTREAMS_TEST_MANIFEST_URL;
const type = process.env.AIOSTREAMS_TEST_TYPE;
const videoIds = [
  process.env.AIOSTREAMS_TEST_VIDEO_ID_1,
  process.env.AIOSTREAMS_TEST_VIDEO_ID_2,
  process.env.AIOSTREAMS_TEST_VIDEO_ID_3,
];
const configured =
  manifestUrl !== undefined &&
  type !== undefined &&
  videoIds.every((videoId) => videoId !== undefined);

describe.skipIf(!configured)(
  "optional live AIOStreams protocol smoke test",
  () => {
    it("loads the manifest, parses three stream responses, and selects a family", async () => {
      const client = new StremioUpstreamClient({
        manifestUrl: manifestUrl!,
        requestTimeoutMs: 30_000,
        manifestCacheTtlMs: 0,
        streamCacheTtlMs: 0,
      });
      const manifest = await client.getManifest();
      expect(
        manifest.resources.some((resource) => resource.name === "stream"),
      ).toBe(true);
      const resolver = new StremioEpisodeSourceResolver(client);
      const selection = await resolver.resolve(
        videoIds.map((videoId, index) => ({
          episodeId: `ep${index + 1}`,
          type: type!,
          videoId: videoId!,
        })),
      );
      expect(selection.episodes).toHaveLength(3);
      expect(selection.familyMethod).toMatch(/binge_group|filename_family/);
      expect(
        selection.episodes
          .map((episode) => episode.subtitles.length)
          .every((count) => count >= 0),
      ).toBe(true);
      if (process.env.AIOSTREAMS_TEST_SUBTITLES === "true") {
        for (const [index, episode] of selection.episodes.entries()) {
          if (episode.videoHash === undefined) continue;
          const subtitles = await client.getSubtitles(
            {
              episodeId: episode.episodeId,
              type: type!,
              videoId: videoIds[index]!,
            },
            episode.videoHash,
            episode.videoSize,
          );
          expect(
            subtitles.every(
              (subtitle) => subtitle.id.length > 0 && subtitle.lang.length > 0,
            ),
          ).toBe(true);
        }
      }
    });
  },
);
