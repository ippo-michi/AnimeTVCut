import base from "./vitest.stremio.config.js";

export default {
  ...base,
  test: {
    ...base.test,
    include: ["apps/server/long-cut-tests/**/*.test.ts"],
    testTimeout: 360_000,
    hookTimeout: 900_000,
  },
};
