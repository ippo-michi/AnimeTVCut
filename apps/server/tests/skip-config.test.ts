import { describe, expect, it } from "vitest";

import { skipProvidersFromEnv } from "../src/services/skip-config.js";

describe("skip provider bootstrap configuration", () => {
  it("enables TheIntroDB and AniSkip by default without making requests", () => {
    expect(
      skipProvidersFromEnv({}).map((provider) => ({
        name: provider.name,
        enabled: provider.enabled,
      })),
    ).toEqual([
      { name: "theintrodb", enabled: true },
      { name: "aniskip", enabled: true },
    ]);
  });

  it("retains disabled providers in health topology", () => {
    expect(
      skipProvidersFromEnv({
        INTRODB_ENABLED: "false",
        ANISKIP_ENABLED: "false",
      }).map((provider) => ({
        name: provider.name,
        enabled: provider.enabled,
      })),
    ).toEqual([
      { name: "theintrodb", enabled: false },
      { name: "aniskip", enabled: false },
    ]);
  });

  it("rejects malformed booleans and unsafe base URLs", () => {
    expect(() => skipProvidersFromEnv({ INTRODB_ENABLED: "yes" })).toThrow(
      /true or false/,
    );
    expect(() =>
      skipProvidersFromEnv({ ANISKIP_BASE_URL: "file:///tmp/provider" }),
    ).toThrow(/HTTP or HTTPS/);
    expect(() =>
      skipProvidersFromEnv({
        ANISKIP_DURATION_MISMATCH_TOLERANCE_SECONDS: "-1",
      }),
    ).toThrow(/tolerance must be non-negative/);
  });
});
