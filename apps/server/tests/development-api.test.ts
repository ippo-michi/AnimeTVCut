import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

describe("development API access", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("disables every development route in production while leaving playback discovery public", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = createApp();
    try {
      for (const url of [
        "/api/v1/dev/cuts",
        "/api/v1/dev/cuts/from-upstream/auto",
        "/api/v1/dev/skip/resolve",
      ])
        expect(
          (await app.inject({ method: "POST", url, payload: {} })).statusCode,
        ).toBe(404);
      expect((await app.inject("/api/v1/dev/metadata/health")).statusCode).toBe(
        404,
      );
      expect((await app.inject("/health")).statusCode).toBe(200);
      expect((await app.inject("/v2/manifest.json")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("requires a token when explicitly enabling production diagnostics", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createApp({ devApiEnabled: true })).toThrow("DEV_API_TOKEN");
    const app = createApp({
      devApiEnabled: true,
      devApiToken: "admin-test-token",
    });
    try {
      for (const authorization of [undefined, "Bearer wrong"])
        expect(
          (
            await app.inject({
              url: "/api/v1/dev/metadata/health",
              headers: { ...(authorization ? { authorization } : {}) },
            })
          ).statusCode,
        ).toBe(401);
      expect(
        (
          await app.inject({
            url: "/api/v1/dev/metadata/health",
            headers: { authorization: "Bearer admin-test-token" },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
