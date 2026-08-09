import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@animetvcut/core": `${root}packages/core/src/index.ts`,
      "@animetvcut/hls": `${root}packages/hls/src/index.ts`,
      "@animetvcut/skip-providers": `${root}packages/skip-providers/src/index.ts`,
    },
  },
  test: {
    include: ["apps/server/mediaflow-tests/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
