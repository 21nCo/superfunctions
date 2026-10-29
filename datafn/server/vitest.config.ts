import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // @datafn/cli's own test task rebuilds (and cleans) its dist, so the codegen
      // tests here import its source rather than race that rebuild.
      "@datafn/cli": fileURLToPath(new URL("../cli/src/index.ts", import.meta.url)),
    },
  },
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
