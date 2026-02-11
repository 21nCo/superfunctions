import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
