import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@animetvcut/core": `${root}packages/core/src/index.ts`,
      "@animetvcut/hls": `${root}packages/hls/src/index.ts`,
    },
  },
  test: {
    include: ["apps/server/live-tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
