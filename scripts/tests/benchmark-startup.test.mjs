import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkStartup } from "../benchmark-startup.mjs";

test("benchmarks each cut mode independently without returning source URLs", async () => {
  const calls = [];
  const results = await benchmarkStartup(
    "https://addon.test/",
    {
      tv: "atc:tv:fixture",
      season: "atc:season:fixture",
      series: "atc:series:fixture",
    },
    3,
    async (url) => {
      calls.push(url.href);
      return globalThis.Response.json({
        playlistUrl: "https://addon.test/media/cut/opaque/master.m3u8",
      });
    },
  );
  assert.equal(calls.length, 9);
  assert.equal(new Set(calls).size, 3);
  assert.deepEqual(
    results.map((row) => row.mode),
    ["tv", "season", "series"],
  );
  assert.ok(results.every((row) => row.attempts === 3 && row.warmP50Ms >= 0));
  assert.ok(!JSON.stringify(results).includes("https://"));
});
test("rejects a failed preview rather than measuring it as a successful startup", async () => {
  await assert.rejects(
    benchmarkStartup(
      "https://addon.test/",
      { tv: "id", season: "id", series: "id" },
      2,
      async () =>
        globalThis.Response.json({ error: "Unavailable" }, { status: 422 }),
    ),
    /tv: Unavailable/,
  );
});
