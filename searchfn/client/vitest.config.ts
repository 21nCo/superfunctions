import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@searchfn/core": resolve(__dirname, "../core/src/index.ts"),
      "@searchfn/adapter-contracts": resolve(__dirname, "../adapter-contracts/src/index.ts"),
      "@searchfn/adapter-memory": resolve(__dirname, "../adapter-memory/src/index.ts"),
      "@searchfn/adapter-indexeddb": resolve(__dirname, "../adapter-indexeddb/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["__tests__/setup.ts"],
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      provider: "v8"
    }
  }
});
