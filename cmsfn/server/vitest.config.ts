import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cmsfn": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@contentfn/core": fileURLToPath(new URL("../../contentfn/core/src/index.ts", import.meta.url)),
      "@superfunctions/errors": fileURLToPath(new URL("../../packages/errors/src/index.ts", import.meta.url)),
      "@superfunctions/envelope": fileURLToPath(new URL("../../packages/envelope/src/index.ts", import.meta.url)),
    },
  },
});
