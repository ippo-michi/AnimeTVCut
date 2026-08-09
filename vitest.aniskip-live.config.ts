import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@animetvcut/skip-providers": `${root}packages/skip-providers/src/index.ts`,
    },
  },
  test: {
    include: ["apps/server/live-tests/aniskip-live.test.ts"],
    testTimeout: 60_000,
  },
});
