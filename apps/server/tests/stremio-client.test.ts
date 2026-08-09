import { describe, expect, it, vi } from "vitest";

import { StremioUpstreamClient } from "../src/services/stremio-upstream/client.js";
import {
  StremioManifestInvalidError,
  StremioStreamResponseInvalidError,
  StremioUpstreamUnavailableError,
} from "../src/services/stremio-upstream/errors.js";

const manifest = {
  id: "org.test.addon",
  name: "AIOStreams",
  version: "1.0.0",
  types: ["series"],
  idPrefixes: ["tt"],
  resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
};
const reference = {
  episodeId: "ep2",
  type: "series",
  videoId: "tt1234567:1:2",
};

function fetchMock(
  implementation: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

function routingFetch(streams: unknown[] = []): typeof fetch {
  return fetchMock(async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/manifest.json")) {
      return Response.json(manifest);
    }
    return Response.json({ streams });
  });
}

describe("Stremio upstream client", () => {
  it("fetches the authenticated resource path and parses candidates", async () => {
    const mock = routingFetch([
      { infoHash: "abc" },
      {
        url: "https://media.test/episode2.mkv",
        behaviorHints: { bingeGroup: "family-A" },
      },
    ]);
    const client = new StremioUpstreamClient(
      {
        manifestUrl: "https://addon.test/stremio/user/secret/manifest.json",
      },
      mock,
    );
    const candidates = await client.getStreams(reference);
    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "torrent",
      "url",
    ]);
    const requested = (mock as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(requested?.toString()).toBe(
      "https://addon.test/stremio/user/secret/stream/series/tt1234567%3A1%3A2.json",
    );
  });

  it("uses five-minute manifest and short stream caches", async () => {
    let time = 1_000;
    const mock = routingFetch([]);
    const client = new StremioUpstreamClient(
      {
        manifestUrl: "https://addon.test/private/manifest.json",
        manifestCacheTtlMs: 300_000,
        streamCacheTtlMs: 45_000,
      },
      mock,
      () => time,
    );
    await client.getStreams(reference);
    await client.getStreams(reference);
    expect(client.stats).toEqual({ manifestRequests: 1, streamRequests: 1 });
    time += 46_000;
    await client.getStreams(reference);
    expect(client.stats).toEqual({ manifestRequests: 1, streamRequests: 2 });
  });

  it("allows tests to disable both caches", async () => {
    const client = new StremioUpstreamClient(
      {
        manifestUrl: "https://addon.test/private/manifest.json",
        manifestCacheTtlMs: 0,
        streamCacheTtlMs: 0,
      },
      routingFetch([]),
    );
    await client.getStreams(reference);
    await client.getStreams(reference);
    expect(client.stats).toEqual({ manifestRequests: 2, streamRequests: 2 });
  });

  it("rejects redirects without following them", async () => {
    const mock = fetchMock(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/manifest.json" },
      });
    });
    const client = new StremioUpstreamClient(
      { manifestUrl: "https://addon.test/private/manifest.json" },
      mock,
    );
    await expect(client.getManifest()).rejects.toThrow(/unexpected redirect/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("classifies upstream timeouts without leaking the URL", async () => {
    const mock = fetchMock(async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("timeout")),
          {
            once: true,
          },
        );
      });
      throw new Error("unreachable");
    });
    const client = new StremioUpstreamClient(
      {
        manifestUrl:
          "https://addon.test/stremio/user/super-secret/manifest.json",
        requestTimeoutMs: 1,
      },
      mock,
    );
    const error = await client.getManifest().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StremioUpstreamUnavailableError);
    expect(String(error)).not.toContain("super-secret");
  });

  it("rejects oversized manifests using Content-Length", async () => {
    const client = new StremioUpstreamClient(
      { manifestUrl: "https://addon.test/private/manifest.json" },
      fetchMock(
        async () =>
          new Response("{}", { headers: { "content-length": "999999" } }),
      ),
    );
    await expect(client.getManifest()).rejects.toThrow(
      StremioManifestInvalidError,
    );
  });

  it("rejects oversized stream responses", async () => {
    const mock = fetchMock(async (input) => {
      const url = new URL(input.toString());
      return url.pathname.endsWith("manifest.json")
        ? Response.json(manifest)
        : new Response("{}", { headers: { "content-length": "3000000" } });
    });
    const client = new StremioUpstreamClient(
      { manifestUrl: "https://addon.test/private/manifest.json" },
      mock,
    );
    await expect(client.getStreams(reference)).rejects.toThrow(
      StremioStreamResponseInvalidError,
    );
  });

  it("rejects candidate-count overflow from an otherwise valid response", async () => {
    const client = new StremioUpstreamClient(
      { manifestUrl: "https://addon.test/private/manifest.json" },
      routingFetch(Array.from({ length: 201 }, () => ({}))),
    );
    await expect(client.getStreams(reference)).rejects.toThrow(/exceeds 200/);
  });

  it("returns sanitized health information", async () => {
    const client = new StremioUpstreamClient(
      {
        manifestUrl:
          "https://addon.test/stremio/user/super-secret/manifest.json",
      },
      routingFetch(),
    );
    const health = await client.checkHealth();
    expect(health).toEqual({
      configured: true,
      reachable: true,
      manifestValid: true,
      origin: "https://addon.test",
      addonName: "AIOStreams",
      addonVersion: "1.0.0",
    });
    expect(JSON.stringify(health)).not.toContain("super-secret");
  });
});
