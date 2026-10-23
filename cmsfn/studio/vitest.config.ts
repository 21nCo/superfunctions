import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
  },
  resolve: {
    conditions: ["browser"],
    alias: {
      "@contentfn/core": fileURLToPath(new URL("../../contentfn/core/src/index.ts", import.meta.url)),
      "@cmsfn/server": fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
      "@superfunctions/errors": fileURLToPath(new URL("../../packages/errors/src/index.ts", import.meta.url)),
      "@superfunctions/envelope": fileURLToPath(new URL("../../packages/envelope/src/index.ts", import.meta.url)),
      "cmsfn": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
