import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, statements: 90, functions: 90 },
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts"],
      reportsDirectory: "../.conduct/coverage",
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
