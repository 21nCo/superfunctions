import path from "path";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    svelte({
      hot: !process.env.VITEST,
      preprocess: vitePreprocess(),
    }),
  ],
  cacheDir: "./.vite-vitest",
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      drawfn: path.resolve(__dirname, "..", "core", "src", "index.ts"),
    },
    conditions: ["browser"],
  },
  ssr: {
    noExternal: ["svelte", "@testing-library/svelte"],
  },
});
