import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    svelte({
      hot: !process.env.VITEST,
      preprocess: vitePreprocess({ script: true }),
    }),
  ],
  cacheDir: "./.vite-vitest",
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.ts"],
    globals: true,
    setupFiles: ["./__tests__/setup.ts"],
  },
  resolve: {
    conditions: ["browser"],
  },
  ssr: {
    noExternal: ["svelte", "@testing-library/svelte"],
  },
});
