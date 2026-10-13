import { defineConfig } from "vitest/config";

/** End-to-end flows: real files, the built CLI, a real MCP client over stdio and installed engines. */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
