import { describe, expect, it } from "vitest";

import {
  reconcileSkipSegments,
  SkipSegmentResolver,
  type SkipProviderResult,
  type SkipSegmentProvider,
} from "../src/index.js";

function result(
  provider: string,
  segments: SkipProviderResult["segments"],
): SkipProviderResult {
  return { provider, status: "found", segments, warnings: [] };
}

function provider(
  name: string,
  priority: number,
  getSegments: SkipSegmentProvider["getSegments"],
): SkipSegmentProvider {
  return {
    name,
    priority,
    supports: () => true,
    getSegments,
  };
}

describe("provider reconciliation", () => {
  const intro = provider("theintrodb", 20, async () =>
    result("theintrodb", []),
  );
  const ani = provider("aniskip", 30, async () => result("aniskip", []));

  it("uses provider priority for strongly overlapping reports without averaging", () => {
    const reconciled = reconcileSkipSegments(
      [
        result("theintrodb", [
          {
            type: "opening",
            start: 90,
            end: 180,
            provider: "theintrodb",
            automaticRemoval: true,
          },
        ]),
        result("aniskip", [
          {
            type: "opening",
            start: 90.1,
            end: 180.1,
            provider: "aniskip",
            automaticRemoval: true,
          },
        ]),
      ],
      [intro, ani],
    );
    expect(reconciled.segments).toEqual([
      expect.objectContaining({
        provider: "theintrodb",
        start: 90,
        end: 180,
        alternatives: [{ provider: "aniskip", start: 90.1, end: 180.1 }],
      }),
    ]);
  });

  it("keeps distinct same-provider recaps separate", () => {
    const reconciled = reconcileSkipSegments(
      [
        result("theintrodb", [
          {
            type: "recap",
            start: 0,
            end: 25,
            provider: "theintrodb",
            automaticRemoval: true,
          },
          {
            type: "recap",
            start: 100,
            end: 110,
            provider: "theintrodb",
            automaticRemoval: true,
          },
        ]),
      ],
      [intro],
    );
    expect(reconciled.segments).toHaveLength(2);
  });

  it("keeps conflicting provider intervals separate and warns", () => {
    const reconciled = reconcileSkipSegments(
      [
        result("theintrodb", [
          {
            type: "opening",
            start: 90,
            end: 180,
            provider: "theintrodb",
            automaticRemoval: true,
          },
        ]),
        result("aniskip", [
          {
            type: "opening",
            start: 300,
            end: 390,
            provider: "aniskip",
            automaticRemoval: true,
          },
        ]),
      ],
      [intro, ani],
    );
    expect(reconciled.segments).toHaveLength(2);
    expect(reconciled.warnings[0]).toMatch(/conflicting/);
  });
});

describe("provider resolver isolation and concurrency", () => {
  it("continues when one provider fails", async () => {
    const resolver = new SkipSegmentResolver([
      provider("failed", 10, async () => {
        throw new Error("secret raw failure");
      }),
      provider("working", 20, async () =>
        result("working", [
          {
            type: "opening",
            start: 0,
            end: 6,
            provider: "working",
            automaticRemoval: true,
          },
        ]),
      ),
    ]);
    const resolved = await resolver.resolveEpisode({
      episodeId: "ep1",
      identity: { imdb: { id: "tt1234567", season: 1, episode: 1 } },
      durationSeconds: 30,
    });
    expect(resolved.providers.map((item) => item.status)).toEqual([
      "provider_failed",
      "found",
    ]);
    expect(resolved.segments).toHaveLength(1);
    expect(JSON.stringify(resolved)).not.toContain("secret raw failure");
  });

  it("distinguishes unsupported identity from not-found", async () => {
    const resolver = new SkipSegmentResolver([
      {
        name: "imdb-only",
        priority: 1,
        supports: (identity) => identity.imdb !== undefined,
        getSegments: async () => ({
          provider: "imdb-only",
          status: "not_found",
          segments: [],
          warnings: [],
        }),
      },
    ]);
    expect(
      (
        await resolver.resolveEpisode({
          episodeId: "ep1",
          identity: {},
          durationSeconds: 30,
        })
      ).providers[0]!.status,
    ).toBe("unsupported_identity");
  });

  it("bounds episode concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const controlled = provider("controlled", 1, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        provider: "controlled",
        status: "not_found",
        segments: [],
        warnings: [],
      };
    });
    const resolver = new SkipSegmentResolver([controlled], 2);
    await resolver.resolveEpisodes(
      Array.from({ length: 8 }, (_, index) => ({
        episodeId: `ep${index}`,
        identity: {},
        durationSeconds: 30,
      })),
    );
    expect(maximum).toBe(2);
  });
});
