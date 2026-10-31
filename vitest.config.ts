import { defineConfig } from "vitest/config";
import { timeScale } from "./packages/core/test/timeLimit.js";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Scaled with the wall-clock limits inside the tests (packages/core/test/timeLimit.ts).
    testTimeout: Math.round(20_000 * timeScale()),
  },
});
