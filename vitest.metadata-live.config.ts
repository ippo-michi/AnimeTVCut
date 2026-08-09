import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@animetvcut/core": `${root}packages/core/src/index.ts`,
      "@animetvcut/stremio": `${root}packages/stremio/src/index.ts`,
    },
  },
  test: {
    include: ["apps/server/live-tests/metadata-live.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
