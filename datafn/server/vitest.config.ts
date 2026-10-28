import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    // Runs under workerd through vitest.workerd.config.ts.
    exclude: ["__tests__/workerd/**"],
    coverage: {
      reporter: ["text", "lcov"],
      provider: "v8",
    },
  },
});
