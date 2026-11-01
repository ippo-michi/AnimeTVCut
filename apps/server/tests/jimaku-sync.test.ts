import { describe, expect, it, vi } from "vitest";
import { JimakuProvider, jimakuFileScore } from "../src/services/jimaku.js";
import { estimateSubtitleOffset } from "../src/services/subtitle-sync.js";
import type { SubtitleEvent } from "@animetvcut/subtitles";

const episodes = [1, 2].map((episode) => ({
  sourceEpisodeId: `e${episode}`,
  season: 1,
  episode,
}));
const events = (offset = 0): SubtitleEvent[] =>
  Array.from({ length: 30 }, (_, i) => ({
    start: 3 + i * 3.5 + (i % 4) * 0.6 + offset,
    end: 4.2 + i * 3.5 + (i % 4) * 0.6 + offset,
    text: `line ${i}`,
    sourceEpisodeId: "e1",
    sourceEpisodeOrder: 0,
    sourceEventOrder: i,
  }));

describe("Jimaku subtitle discovery", () => {
  it("matches episode numbers and excludes mismatches and non-dialogue files", () => {
    expect(jimakuFileScore("Show S01E02.ass", 1, 2)).toBeGreaterThan(0);
    expect(jimakuFileScore("Show S02E02.ass", 1, 2)).toBe(-1);
    expect(jimakuFileScore("Show - 02.srt", 1, 2)).toBeGreaterThan(0);
    expect(jimakuFileScore("Show - 12.srt", 1, 2)).toBe(-1);
    expect(jimakuFileScore("Show - 02 [English].srt", 1, 2)).toBe(-1);
    expect(jimakuFileScore("Show - 02.zip", 1, 2)).toBe(-1);
  });
  it("uses MAL identity, authenticates Jimaku requests, and selects a complete consistent family", async () => {
    const request = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const address = String(url);
        if (address.startsWith("https://graphql.anilist.co"))
          return Response.json({ data: { Media: { id: 42 } } });
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "test-key",
        );
        if (address.includes("search")) {
          expect(address).toContain("anilist_id=42");
          return Response.json([{ id: 123, name: "Show", anilist_id: 42 }]);
        }
        return Response.json([
          { name: "Show - 01.ass", url: "https://jimaku.cc/01.ass" },
          { name: "Show - 02.ass", url: "https://jimaku.cc/02.ass" },
          { name: "Show - 02.zip", url: "https://jimaku.cc/02.zip" },
        ]);
      },
    );
    const provider = new JimakuProvider(
      "test-key",
      1000,
      request as typeof fetch,
    );
    const found = await provider.find({
      title: "Show",
      malAnimeId: 3,
      episodes,
    });
    expect(found.map(({ episodeId, file }) => [episodeId, file.name])).toEqual([
      ["e1", "Show - 01.ass"],
      ["e2", "Show - 02.ass"],
    ]);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("does not fabricate a complete family when an episode is missing", async () => {
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("search")
        ? Response.json([{ id: 1, name: "Show" }])
        : Response.json([
            { name: "Show - 01.srt", url: "https://jimaku.cc/1.srt" },
          ]),
    );
    expect(
      await new JimakuProvider("key", 1000, request as typeof fetch).find({
        title: "Show",
        episodes,
      }),
    ).toEqual([]);
  });
  it("prefers a complete Japanese-only family over bilingual ASS files", async () => {
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("search")
        ? Response.json([{ id: 1, name: "Show" }])
        : Response.json(
            [1, 2].flatMap((ep) => [
              {
                name: `Show - 0${ep}.ja-en.ass`,
                url: `https://jimaku.cc/${ep}.ass`,
              },
              {
                name: `Show - 0${ep}.ja.srt`,
                url: `https://jimaku.cc/${ep}.srt`,
              },
            ]),
          ),
    );
    const files = await new JimakuProvider(
      "key",
      1000,
      request as typeof fetch,
    ).find({ title: "Show", episodes });
    expect(files.map(({ file }) => file.name)).toEqual([
      "Show - 01.ja.srt",
      "Show - 02.ja.srt",
    ]);
  });
  it("does not combine episodes from separate series entries", async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const address = String(url);
      if (address.includes("search"))
        return Response.json([
          { id: 1, name: "Show" },
          { id: 2, name: "Show sequel" },
        ]);
      return Response.json(
        address.includes("/1/files")
          ? [{ name: "Show - 01.srt", url: "https://jimaku.cc/1.srt" }]
          : [{ name: "Show - 02.srt", url: "https://jimaku.cc/2.srt" }],
      );
    });
    expect(
      await new JimakuProvider("key", 1000, request as typeof fetch).find({
        title: "Show",
        episodes,
      }),
    ).toEqual([]);
  });
  it("fails safely on authentication and rate-limit errors", async () => {
    for (const status of [401, 429]) {
      const provider = new JimakuProvider(
        "private-key",
        1000,
        async () => new Response("denied", { status }),
      );
      await expect(provider.find({ title: "Show", episodes })).rejects.toThrow(
        "jimaku_request_failed",
      );
    }
  });
});

describe("subtitle activity alignment", () => {
  it("finds positive and negative offsets for different languages", () => {
    expect(estimateSubtitleOffset(events(), events(4))).toBe(-4);
    expect(estimateSubtitleOffset(events(), events(-2))).toBe(2);
  });
  it("does not adjust sparse or ambiguous activity", () => {
    expect(
      estimateSubtitleOffset(events().slice(0, 3), events().slice(0, 3)),
    ).toBeUndefined();
    const repeated = events().map((e, i) => ({
      ...e,
      start: i * 4,
      end: i * 4 + 1,
    }));
    expect(estimateSubtitleOffset(repeated, repeated)).toBeUndefined();
  });
});
