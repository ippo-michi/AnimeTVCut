import { describe, expect, it, vi } from "vitest";

import { StremioEpisodeSourceResolver } from "../src/services/stremio-upstream/resolver.js";
import type {
  StremioStreamCandidate,
  UpstreamEpisodeReference,
} from "../src/services/stremio-upstream/types.js";

function reference(index: number): UpstreamEpisodeReference {
  return {
    episodeId: `episode-${index}`,
    type: "series",
    videoId: `kitsu:46474:${index}`,
  };
}

function usableCandidate(index: number): StremioStreamCandidate {
  return {
    kind: "url",
    rank: 0,
    url: `https://media.test/episode-${index}.mkv`,
    bingeGroup: "family-a",
    subtitles: [],
    requestHeaders: {},
  };
}

describe("Stremio episode source resolver", () => {
  it("bounds episode requests and retries transient no-URL responses", async () => {
    let active = 0;
    let maximumActive = 0;
    const attempts = new Map<string, number>();
    const getStreams = vi.fn(async (episode: UpstreamEpisodeReference) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;

      const count = (attempts.get(episode.episodeId) ?? 0) + 1;
      attempts.set(episode.episodeId, count);
      return count === 1
        ? [{ kind: "unsupported", rank: 0, reason: "provider pending" }]
        : [usableCandidate(Number(episode.episodeId.replace("episode-", "")))];
    });
    const resolver = new StremioEpisodeSourceResolver({ getStreams } as never, {
      maxConcurrentEpisodeRequests: 2,
      noUrlRetryAttempts: 1,
      retryDelayMs: 0,
    });
    const episodes = Array.from({ length: 6 }, (_, index) =>
      reference(index + 1),
    );

    const selection = await resolver.resolve(episodes);

    expect(maximumActive).toBe(2);
    expect(selection.episodes.map((episode) => episode.episodeId)).toEqual(
      episodes.map((episode) => episode.episodeId),
    );
    expect(
      episodes.every((episode) => attempts.get(episode.episodeId) === 2),
    ).toBe(true);
  });
});
