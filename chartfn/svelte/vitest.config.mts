import path from "node:path";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      chartfn: path.resolve(__dirname, "..", "src", "index.ts"),
    },
    conditions: ["browser", "development"],
  },
  ssr: {
    noExternal: ["svelte", "@testing-library/svelte"],
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
});
