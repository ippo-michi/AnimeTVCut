import { describe, expect, it } from "vitest";

import { MetadataStremioClient } from "../src/index.js";

const manifest = {
  id: "fixture.metadata",
  name: "Fixture Metadata",
  version: "1.0.0",
  types: ["series"],
  resources: ["catalog", "meta"],
  catalogs: [
    {
      id: "fixture-series",
      type: "series",
      extra: [{ name: "search", isRequired: true }],
    },
  ],
};

/**
 * Helper: creates a fetch mock that simulates a hanging request.
 * The mock listens to the abort signal and rejects when aborted,
 * so timeouts work correctly.
 */
function hangingFetch(
  respondAfter?: (url: URL) => Response | Promise<Response>,
): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    return new Promise<Response>((resolve, reject) => {
      // If there's a custom handler, use it
      if (respondAfter) {
        const result = respondAfter(url);
        if (result instanceof Promise) {
          result.then(
            (r) => resolve(r),
            (e) => reject(e instanceof Error ? e : new Error(String(e))),
          );
        } else {
          resolve(result);
        }
        return;
      }
      // Listen for abort signal
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      // If already aborted, reject immediately
      if (init?.signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      // Otherwise hang forever (will be aborted by timeout)
    });
  };
}

describe("MetadataStremioClient manifestInFlight signal safety", () => {
  it("completes within timeout when manifest endpoint never responds", async () => {
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 500,
      },
      hangingFetch(),
    );

    const start = Date.now();
    await expect(client.getManifest()).rejects.toThrow(/timed out|cancelled/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  it("completes within timeout when catalog endpoint never responds", async () => {
    let manifestCalled = false;
    const hangingFetchWithManifest = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        manifestCalled = true;
        return new Response(JSON.stringify(manifest));
      }
      // Catalog endpoint hangs
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        if (init?.signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }
      });
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        catalogCacheTtlMs: 0,
        requestTimeoutMs: 500,
      },
      hangingFetchWithManifest,
    );

    const start = Date.now();
    await expect(client.searchSeries("test")).rejects.toThrow(
      /timed out|cancelled/i,
    );
    const elapsed = Date.now() - start;
    expect(manifestCalled).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  it("manifest succeeds but catalog stalls completes within timeout", async () => {
    const catalogStalled = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        return new Response(JSON.stringify(manifest));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        if (init?.signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        }
      });
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        catalogCacheTtlMs: 0,
        requestTimeoutMs: 500,
      },
      catalogStalled,
    );

    const start = Date.now();
    await expect(client.searchSeries("test")).rejects.toThrow(
      /timed out|cancelled/i,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });

  it("two concurrent first searches share manifestInFlight", async () => {
    let manifestFetchCount = 0;
    const sharedFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        manifestFetchCount++;
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify(manifest));
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 5000,
      },
      sharedFetch,
    );

    const [resultA, resultB] = await Promise.all([
      client.getManifest(),
      client.getManifest(),
    ]);

    expect(resultA).toEqual(resultB);
    expect(manifestFetchCount).toBe(1);
  });

  it("caller A creates shared request, caller B joins with its own signal", async () => {
    let resolveFetch!: () => void;
    let fetchStarted = false;

    const slowManifestFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchStarted = true;
        return new Promise<Response>((resolve) => {
          resolveFetch = () => {
            resolve(new Response(JSON.stringify(manifest)));
          };
          if (init?.signal?.aborted) {
            resolve(new Response(JSON.stringify(manifest)));
          }
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 10_000,
      },
      slowManifestFetch,
    );

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    // Start A first
    const promiseA = client.getManifest(controllerA.signal);

    // Wait for fetch to start
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchStarted).toBe(true);

    // B joins with its own signal
    const promiseB = client.getManifest(controllerB.signal);

    // Resolve the fetch
    resolveFetch();

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    expect(resultA.name).toBe("Fixture Metadata");
    expect(resultB.name).toBe("Fixture Metadata");
  });

  it("abort B → B rejects immediately, A still succeeds", async () => {
    let resolveFetch!: () => void;
    let fetchStarted = false;

    const slowManifestFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchStarted = true;
        return new Promise<Response>((resolve) => {
          resolveFetch = () => {
            resolve(new Response(JSON.stringify(manifest)));
          };
          if (init?.signal?.aborted) {
            resolve(new Response(JSON.stringify(manifest)));
          }
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 10_000,
      },
      slowManifestFetch,
    );

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const promiseA = client.getManifest(controllerA.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchStarted).toBe(true);

    const promiseB = client.getManifest(controllerB.signal);

    // Abort B
    controllerB.abort();
    await expect(promiseB).rejects.toThrow();

    // A should still succeed
    resolveFetch();
    const resultA = await promiseA;
    expect(resultA.name).toBe("Fixture Metadata");
  });

  it("abort A → A rejects, B still succeeds", async () => {
    let resolveFetch!: () => void;
    let fetchStarted = false;

    const slowManifestFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchStarted = true;
        return new Promise<Response>((resolve) => {
          resolveFetch = () => {
            resolve(new Response(JSON.stringify(manifest)));
          };
          if (init?.signal?.aborted) {
            resolve(new Response(JSON.stringify(manifest)));
          }
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 10_000,
      },
      slowManifestFetch,
    );

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const promiseA = client.getManifest(controllerA.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchStarted).toBe(true);

    const promiseB = client.getManifest(controllerB.signal);

    // Abort A
    controllerA.abort();
    await expect(promiseA).rejects.toThrow();

    // B should still succeed
    resolveFetch();
    const resultB = await promiseB;
    expect(resultB.name).toBe("Fixture Metadata");
  });

  it("abort A, then before upstream resolves start caller C → only one manifest fetch total", async () => {
    let fetchCount = 0;
    let resolveFetch!: () => void;

    const slowManifestFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchCount++;
        return new Promise<Response>((resolve) => {
          resolveFetch = () => {
            resolve(new Response(JSON.stringify(manifest)));
          };
          if (init?.signal?.aborted) {
            resolve(new Response(JSON.stringify(manifest)));
          }
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 10_000,
      },
      slowManifestFetch,
    );

    const controllerA = new AbortController();
    const controllerC = new AbortController();

    const promiseA = client.getManifest(controllerA.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCount).toBe(1);

    // Abort A — this should NOT clear manifestInFlight
    controllerA.abort();
    await expect(promiseA).rejects.toThrow();

    // C joins the existing in-flight request
    const promiseC = client.getManifest(controllerC.signal);

    // Resolve the fetch
    resolveFetch();

    const resultC = await promiseC;
    expect(resultC.name).toBe("Fixture Metadata");
    expect(fetchCount).toBe(1); // only one fetch
  });

  it("both callers abort → shared request remains alive until timeout", async () => {
    let fetchCount = 0;

    const slowManifestFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchCount++;
        // Never resolve — will be aborted by timeout
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 500,
      },
      slowManifestFetch,
    );

    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const promiseA = client.getManifest(controllerA.signal);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchCount).toBe(1);

    const promiseB = client.getManifest(controllerB.signal);

    // Both abort
    controllerA.abort();
    controllerB.abort();

    // Both should reject
    await expect(promiseA).rejects.toThrow();
    await expect(promiseB).rejects.toThrow();

    // The shared fetch should still be alive (aborted by timeout, not by callers)
    // Wait for the internal timeout to fire
    await new Promise((r) => setTimeout(r, 600));

    // Next call should create a fresh fetch
    const fetchCountBefore = fetchCount;
    const controllerD = new AbortController();
    const promiseD = client.getManifest(controllerD.signal);
    await promiseD.catch(() => {}); // ignore error
    // The fetch should have been retried after the timeout
    expect(fetchCount).toBeGreaterThan(fetchCountBefore);
  });

  it("after shared failure, next request creates exactly one new fetch", async () => {
    let fetchCount = 0;

    const failingFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/manifest.json")) {
        fetchCount++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        });
      }
      return new Response(JSON.stringify({ metas: [] }));
    };

    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 500,
      },
      failingFetch,
    );

    // First request fails (timeout)
    await expect(client.getManifest()).rejects.toThrow();
    expect(fetchCount).toBe(1);

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 600));

    // Next request creates exactly one new fetch
    const controller = new AbortController();
    await expect(client.getManifest(controller.signal)).rejects.toThrow();
    expect(fetchCount).toBe(2); // exactly one more
  });

  it("upstream returns invalid JSON", async () => {
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 5000,
      },
      async () => new Response("not json at all {{{"),
    );

    await expect(client.getManifest()).rejects.toThrow(
      /not valid JSON|invalid/i,
    );
  });

  it("upstream returns redirect", async () => {
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 5000,
      },
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/manifest.json" },
        }),
    );

    await expect(client.getManifest()).rejects.toThrow(/redirect/i);
  });

  it("upstream returns 5xx", async () => {
    const client = new MetadataStremioClient(
      {
        manifestUrl: "https://metadata.test/manifest.json",
        manifestCacheTtlMs: 0,
        requestTimeoutMs: 5000,
      },
      async () => new Response("server error", { status: 500 }),
    );

    await expect(client.getManifest()).rejects.toThrow(/HTTP 500|failed/i);
  });
});
