import { describe, expect, it, vi } from "vitest";

import {
  SkipProviderHttpError,
  TheIntroDbProvider,
  type SkipSegmentRequest,
} from "../src/index.js";

const request: SkipSegmentRequest = {
  identity: { imdb: { id: "tt1234567", season: 1, episode: 3 } },
  durationSeconds: 1_440.008,
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("TheIntroDB provider", () => {
  it("builds the v3 media request with normalized duration", () => {
    const provider = new TheIntroDbProvider({
      baseUrl: "https://intro.test/v3/",
      cacheTtlMs: 0,
    });
    const url = provider.buildLookupUrl(request);
    expect(url.origin + url.pathname).toBe("https://intro.test/v3/media");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      imdb_id: "tt1234567",
      season: "1",
      episode: "3",
      duration_ms: "1440008",
    });
  });

  it("maps all arrays, multiple recaps, metadata, and null starts", async () => {
    const provider = new TheIntroDbProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        intro: [
          {
            start_ms: null,
            end_ms: 6_000,
            confidence: 0.9,
            submission_count: 4,
          },
        ],
        recap: [
          { start_ms: null, end_ms: 2_000 },
          { start_ms: 10_000, end_ms: 12_000 },
        ],
        credits: [{ start_ms: 24_000, end_ms: 28_000 }],
        preview: [{ start_ms: 28_000, end_ms: 30_000 }],
      }),
    });
    const result = await provider.getSegments({
      ...request,
      durationSeconds: 30,
    });
    expect(result.status).toBe("found");
    expect(result.segments).toEqual([
      expect.objectContaining({
        type: "opening",
        start: 0,
        end: 6,
        confidence: 0.9,
        submissionCount: 4,
        automaticRemoval: true,
      }),
      expect.objectContaining({ type: "recap", start: 0, end: 2 }),
      expect.objectContaining({ type: "recap", start: 10, end: 12 }),
      expect.objectContaining({ type: "ending", start: 24, end: 28 }),
      expect.objectContaining({ type: "preview", start: 28, end: 30 }),
    ]);
  });

  it("keeps null-ended credits and previews as open-ended diagnostics", async () => {
    const provider = new TheIntroDbProvider({
      cacheTtlMs: 0,
      fetchImplementation: jsonFetch({
        credits: [{ start_ms: 24_000, end_ms: null }],
        preview: [{ start_ms: 28_000, end_ms: null }],
      }),
    });
    const result = await provider.getSegments({
      ...request,
      durationSeconds: 30,
    });
    expect(result.segments).toEqual([
      expect.objectContaining({
        type: "ending",
        end: null,
        automaticRemoval: false,
        unsafeReason: "open_ended",
      }),
      expect.objectContaining({
        type: "preview",
        end: null,
        automaticRemoval: false,
        unsafeReason: "open_ended",
      }),
    ]);
  });

  it("retains low-confidence and invalid bounded reports diagnostically", async () => {
    const provider = new TheIntroDbProvider({
      cacheTtlMs: 0,
      minimumConfidence: 0.8,
      fetchImplementation: jsonFetch({
        intro: [
          { start_ms: 0, end_ms: 6_000, confidence: 0.4 },
          { start_ms: -1_000, end_ms: 2_000 },
          { start_ms: 29_000, end_ms: 40_000 },
          { start_ms: "bad", end_ms: 2_000 },
        ],
      }),
    });
    const result = await provider.getSegments({
      ...request,
      durationSeconds: 30,
    });
    // Tolerance is 0.5s: end=40 > 30 + 0.5 = 30.5 → outside_duration
    expect(result.segments.map((item) => item.unsafeReason)).toEqual([
      "low_confidence",
      "outside_duration",
      "outside_duration",
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  it("treats absent or empty arrays and 404 as not found", async () => {
    for (const provider of [
      new TheIntroDbProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({}),
      }),
      new TheIntroDbProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({ intro: [], credits: [] }),
      }),
      new TheIntroDbProvider({
        cacheTtlMs: 0,
        fetchImplementation: jsonFetch({}, 404),
      }),
    ]) {
      expect((await provider.getSegments(request)).status).toBe("not_found");
    }
  });

  it("classifies HTTP, malformed JSON, oversized, and timeout failures", async () => {
    const cases: Array<typeof fetch> = [
      jsonFetch({}, 500),
      vi.fn(async () => Promise.resolve(new Response("not-json"))),
      vi.fn(async () =>
        Promise.resolve(
          new Response("{}", { headers: { "content-length": "999999" } }),
        ),
      ),
      vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    ];
    for (const [index, fetchImplementation] of cases.entries()) {
      const provider = new TheIntroDbProvider({
        cacheTtlMs: 0,
        requestTimeoutMs: index === 3 ? 1 : 100,
        fetchImplementation,
      });
      await expect(provider.getSegments(request)).rejects.toBeInstanceOf(
        SkipProviderHttpError,
      );
    }
  });

  it("caches by identity and exact normalized duration", async () => {
    const fetchImplementation = jsonFetch({ intro: [] });
    const provider = new TheIntroDbProvider({
      cacheTtlMs: 60_000,
      fetchImplementation,
    });
    await provider.getSegments(request);
    await provider.getSegments(request);
    await provider.getSegments({ ...request, durationSeconds: 1_441 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
