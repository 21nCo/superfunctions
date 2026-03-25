import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-auto";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const fromDocsRoot = (...segments) => path.resolve(thisDirectory, ...segments);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      "@docsfn/core/search-runtime": fromDocsRoot("../core/src/search-runtime.ts"),
      "@docsfn/core/search": fromDocsRoot("../core/src/search.ts"),
      "@docsfn/core/analytics": fromDocsRoot("../core/src/analytics.ts"),
      "@docsfn/core/browser": fromDocsRoot("../core/src/browser.ts"),
      "@docsfn/core": fromDocsRoot("../core/src/index.ts"),
      "@docsfn/provider-fs": fromDocsRoot("../provider-fs/src/index.ts"),
      "@docsfn/sveltekit": fromDocsRoot("../sveltekit/src/index.ts"),
      "@docsfn/svelte": fromDocsRoot("../svelte/src/index.ts"),
    },
  },
};

export default config;
