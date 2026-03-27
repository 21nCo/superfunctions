import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@docsfn/core": resolve(__dirname, "../core/src/index.ts"),
      "@docsfn/next": resolve(__dirname, "../next/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
