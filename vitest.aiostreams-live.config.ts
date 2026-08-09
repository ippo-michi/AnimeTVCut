import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@animetvcut/core": `${root}packages/core/src/index.ts`,
      "@animetvcut/hls": `${root}packages/hls/src/index.ts`,
      "@animetvcut/skip-providers": `${root}packages/skip-providers/src/index.ts`,
      "@animetvcut/stremio": `${root}packages/stremio/src/index.ts`,
    },
  },
  test: {
    include: ["apps/server/live-tests/aiostreams-live.test.ts"],
    testTimeout: 60_000,
  },
});
