import { describe, expect, it } from "vitest";

import { BoundedCache } from "../src/bounded-cache.js";

describe("bounded expiring caches", () => {
  it("retains recently used entries and reclaims untouched expired entries", () => {
    let now = 0;
    const cache = new BoundedCache<string, { expiresAt: number }>(2, () => now);
    cache.set("active", { expiresAt: 100 });
    cache.set("old", { expiresAt: 100 });
    cache.get("active");
    cache.set("new", { expiresAt: 10 });
    expect(cache.has("old")).toBe(false);
    expect(cache.has("active")).toBe(true);
    expect(cache.size).toBe(2);
    now = 20;
    cache.cleanup();
    expect(cache.size).toBe(1);
    expect(cache.stats()).toMatchObject({ evicted: 1, expired: 1 });
    now = 101;
    expect(cache.get("active")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
