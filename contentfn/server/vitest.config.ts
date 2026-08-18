import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@contentfn/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
