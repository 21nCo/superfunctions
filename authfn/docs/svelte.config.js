import path from "node:path";
import { fileURLToPath } from "node:url";
import adapterAuto from "@sveltejs/adapter-auto";
import adapterCloudflare from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirectory = path.dirname(thisFilePath);
const fromDocsRoot = (...segments) => path.resolve(thisDirectory, ...segments);
const docsDeploy = process.env.CLOUDFLARE_DOCS_DEPLOY === "1";
const adapter = docsDeploy ? adapterCloudflare() : adapterAuto();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter,
    appDir: docsDeploy ? "docs/_app" : "_app",
    paths: {
      assets: process.env.CLOUDFLARE_DOCS_ASSETS_ORIGIN ?? "",
    },
    alias: {
      "@docsfn/core/search-runtime": fromDocsRoot("../../docsfn/core/src/search-runtime.ts"),
      "@docsfn/core/search": fromDocsRoot("../../docsfn/core/src/search.ts"),
      "@docsfn/core/analytics": fromDocsRoot("../../docsfn/core/src/analytics.ts"),
      "@docsfn/core/browser": fromDocsRoot("../../docsfn/core/src/browser.ts"),
      "@docsfn/core": fromDocsRoot("../../docsfn/core/src/index.ts"),
      "@docsfn/provider-fs": fromDocsRoot("../../docsfn/provider-fs/src/index.ts"),
      "@docsfn/sveltekit": fromDocsRoot("../../docsfn/sveltekit/src/index.ts"),
      "@docsfn/svelte": fromDocsRoot("../../docsfn/svelte/src/index.ts"),
      "@uifn/svelte": fromDocsRoot("../../uifn/svelte/src/index.ts"),
      "@uifn/core": fromDocsRoot("../../uifn/core/src/index.ts"),
      "@uifn/core/*": fromDocsRoot("../../uifn/core/src/*"),
      "@searchfn/client": fromDocsRoot("../../searchfn/client/src/index.ts"),
      "@searchfn/core": fromDocsRoot("../../searchfn/core/src/index.ts"),
      "@searchfn/adapter-contracts": fromDocsRoot("../../searchfn/adapter-contracts/src/index.ts"),
      "@searchfn/adapter-memory": fromDocsRoot("../../searchfn/adapter-memory/src/index.ts"),
      "@searchfn/adapter-indexeddb": fromDocsRoot("../../searchfn/adapter-indexeddb/src/index.ts"),
    },
  },
};

export default config;
