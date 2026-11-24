import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/cli/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The end-to-end suite starts servers on fixed local ports; run files one at a time.
    fileParallelism: false,
  },
});
