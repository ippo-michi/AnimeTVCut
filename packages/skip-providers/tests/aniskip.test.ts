import { describe, expect, it, vi } from "vitest";

import { AniSkipProvider, type SkipSegmentRequest } from "../src/index.js";

const request: SkipSegmentRequest = {
  identity: { mal: { animeId: 52_991, episode: 2 } },
  durationSeconds: 30.008,
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

describe("AniSkip provider", () => {
  it("builds the v2 request with all conservative Phase 4 types", () => {
    const provider = new AniSkipProvider({ baseUrl: "https://ani.test/v2/" });
    const url = provider.buildLookupUrl(request);
    expect(url.origin + url.pathname).toBe(
      "https://ani.test/v2/skip-times/52991/2",
    );
    expect(url.searchParams.getAll("types[]")).toEqual([
      "op",
      "ed",
      "mixed-op",
      "mixed-ed",
      "recap",
    ]);
    expect(url.searchParams.get("episodeLength")).toBe("30.008");
  });

  it("maps op, ed, and recap as safe automatic candidates", async () => {
    const provider = new AniSkipProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        found: true,
        results: [
          { interval: { startTime: 0, endTime: 6 }, skipType: "op" },
          { interval: { startTime: 24, endTime: 30 }, skipType: "ed" },
          { interval: { startTime: 6, endTime: 8 }, skipType: "recap" },
        ],
      }),
    });
    const result = await provider.getSegments(request);
    expect(
      result.segments.map((item) => [item.type, item.automaticRemoval]),
    ).toEqual([
      ["opening", true],
      ["ending", true],
      ["recap", true],
    ]);
  });

  it("keeps mixed OP and ED as diagnostic-only mixed content", async () => {
    const provider = new AniSkipProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        found: true,
        results: [
          { interval: { startTime: 0, endTime: 6 }, skipType: "mixed-op" },
          { interval: { startTime: 24, endTime: 30 }, skipType: "mixed-ed" },
        ],
      }),
    });
    const result = await provider.getSegments(request);
    expect(result.segments).toEqual([
      expect.objectContaining({
        type: "opening",
        sourceType: "mixed-op",
        automaticRemoval: false,
        unsafeReason: "mixed_content",
      }),
      expect.objectContaining({
        type: "ending",
        sourceType: "mixed-ed",
        automaticRemoval: false,
        unsafeReason: "mixed_content",
      }),
    ]);
  });

  it("marks provider episode-length mismatch unsafe without scaling", async () => {
    const provider = new AniSkipProvider({
      cacheTtlMs: 0,
      durationMismatchToleranceSeconds: 1,
      fetchImplementation: jsonFetch({
        found: true,
        results: [
          {
            interval: { startTime: 0, endTime: 6 },
            skipType: "op",
            episodeLength: 40,
          },
        ],
      }),
    });
    expect((await provider.getSegments(request)).segments[0]).toMatchObject({
      start: 0,
      end: 6,
      automaticRemoval: false,
      unsafeReason: "duration_mismatch",
    });
  });

  it("accepts small release-duration differences by default", async () => {
    const provider = new AniSkipProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        found: true,
        results: [
          {
            interval: { startTime: 1388.041, endTime: 1478.041 },
            skipType: "ed",
            episodeLength: 1479.5197,
          },
        ],
      }),
    });
    const result = await provider.getSegments({
      identity: { mal: { animeId: 52_034, episode: 2 } },
      durationSeconds: 1482,
    });
    expect(result.segments[0]).toMatchObject({
      type: "ending",
      start: 1388.041,
      end: 1478.041,
      automaticRemoval: true,
    });
  });

  it("preserves invalid known intervals diagnostically and ignores malformed ones", async () => {
    const provider = new AniSkipProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        found: true,
        results: [
          { interval: { startTime: -1, endTime: 6 }, skipType: "op" },
          { interval: { startTime: 8, endTime: 4 }, skipType: "recap" },
          { interval: { startTime: 29, endTime: 40 }, skipType: "ed" },
          { interval: { startTime: "bad", endTime: 4 }, skipType: "op" },
          { interval: { startTime: 1, endTime: 2 }, skipType: "unknown" },
        ],
      }),
    });
    const result = await provider.getSegments(request);
    expect(result.segments.map((item) => item.unsafeReason)).toEqual([
      "outside_duration",
      "invalid_range",
      "outside_duration",
    ]);
    expect(result.warnings).toHaveLength(2);
  });

  it("treats found=false, empty results, and 404 as not found", async () => {
    for (const provider of [
      new AniSkipProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({ found: false, results: [] }),
      }),
      new AniSkipProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({ found: true, results: [] }),
      }),
      new AniSkipProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({}, 404),
      }),
    ]) {
      expect((await provider.getSegments(request)).status).toBe("not_found");
    }
  });

  it("rejects malformed JSON, HTTP failure, timeout, and malformed top-level data", async () => {
    const fetches: Array<typeof fetch> = [
      vi.fn(async () => Promise.resolve(new Response("bad"))),
      jsonFetch({}, 503),
      vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
      jsonFetch({ found: true, results: "bad" }),
    ];
    for (const [index, fetchImplementation] of fetches.entries()) {
      const provider = new AniSkipProvider({
        cacheTtlMs: 0,
        requestTimeoutMs: index === 2 ? 1 : 100,
        fetchImplementation,
      });
      await expect(provider.getSegments(request)).rejects.toThrow();
    }
  });
});
