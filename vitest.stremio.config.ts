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
    include: ["apps/server/stremio-tests/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
