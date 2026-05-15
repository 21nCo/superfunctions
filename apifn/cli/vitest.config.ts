import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@apifn/collections": path.resolve(__dirname, "../collections/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: true,
  },
});
