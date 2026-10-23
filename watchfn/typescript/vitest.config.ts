import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@superfunctions/http-sveltekit": fileURLToPath(
        new URL("../../packages/http-sveltekit/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
