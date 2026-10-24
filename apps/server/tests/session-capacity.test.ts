import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

const payload = {
  sources: [{ episodeId: "ep1", playlistUrl: "fixture://episode1" }],
  remove: [],
};

describe("session capacity and maintenance", () => {
  it("rejects new cuts at capacity without evicting a viewer's active cut", async () => {
    const app = createApp({ maxSessions: 1 });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/dev/cuts",
        payload,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/dev/cuts",
        payload,
      });
      expect(second.statusCode).toBe(503);
      expect(
        (await app.inject(first.json<{ playlistUrl: string }>().playlistUrl))
          .statusCode,
      ).toBe(200);
      const diagnostics = (await app.inject("/api/v1/dev/diagnostics")).json();
      expect(diagnostics.sessions).toMatchObject({ active: 1, limit: 1 });
      expect(diagnostics.memory.rss).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("enforces the memory budget and expires idle sessions without a new cut request", async () => {
    let now = 1000;
    const app = createApp({
      sessionTtlMilliseconds: 10,
      cleanupIntervalMs: 10,
      now: () => now,
    });
    const small = createApp({ maxSessionMemoryBytes: 1 });
    try {
      expect(
        (
          await small.inject({
            method: "POST",
            url: "/api/v1/dev/cuts",
            payload,
          })
        ).statusCode,
      ).toBe(503);
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/dev/cuts", payload }))
          .statusCode,
      ).toBe(200);
      now = 2000;
      await vi.waitFor(async () => {
        expect(
          (await app.inject("/api/v1/dev/diagnostics")).json().sessions.active,
        ).toBe(0);
      });
    } finally {
      await app.close();
      await small.close();
    }
  });
});
