import { performance } from "node:perf_hooks";

/** Measures preparation (not video decode), separating first request from warm reuse. */
export async function benchmarkStartup(
  baseUrl,
  ids,
  attempts = 5,
  fetchImplementation = globalThis.fetch,
) {
  if (!Number.isSafeInteger(attempts) || attempts < 2 || attempts > 20)
    throw new Error("Attempts must be between 2 and 20.");
  const results = [];
  for (const mode of ["tv", "season", "series"]) {
    if (!ids[mode]) throw new Error(`Missing ${mode} video ID.`);
    const samples = [];
    for (let index = 0; index < attempts; index++) {
      const start = performance.now();
      const response = await fetchImplementation(
        new URL(`api/v1/preview/cut/${encodeURIComponent(ids[mode])}`, baseUrl),
        { signal: globalThis.AbortSignal.timeout(300_000) },
      );
      const result = await response.json();
      if (!response.ok || !result.playlistUrl)
        throw new Error(`${mode}: ${result.error ?? "preparation failed"}`);
      samples.push(Math.round(performance.now() - start));
    }
    const warm = samples.slice(1).sort((a, b) => a - b);
    results.push({
      mode,
      firstRequestMs: samples[0],
      warmP50Ms: warm[Math.ceil(warm.length * 0.5) - 1],
      warmP95Ms: warm[Math.ceil(warm.length * 0.95) - 1],
      attempts,
    });
  }
  return results;
}
if (process.argv[1]?.endsWith("benchmark-startup.mjs")) {
  const [baseUrl, tv, season, series, attempts] = process.argv.slice(2);
  if (!baseUrl || !tv || !season || !series)
    throw new Error(
      "Usage: node scripts/benchmark-startup.mjs <base-url/> <tv-id> <season-id> <series-id> [attempts]",
    );
  process.stdout.write(
    JSON.stringify(
      await benchmarkStartup(
        baseUrl,
        { tv, season, series },
        attempts === undefined ? 5 : Number(attempts),
      ),
      null,
      2,
    ) + "\n",
  );
}
