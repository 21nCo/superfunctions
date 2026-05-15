import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
    }),
  ],
  resolve: {
    conditions: ["browser"],
    alias: [
      { find: "@docsfn/core/browser", replacement: resolve(root, "../core/src/browser.ts") },
      { find: "@docsfn/core/search-runtime", replacement: resolve(root, "../core/src/search-runtime.ts") },
      { find: "@docsfn/core/search", replacement: resolve(root, "../core/src/search.ts") },
      { find: "@docsfn/core/analytics", replacement: resolve(root, "../core/src/analytics.ts") },
      { find: /^@docsfn\/core$/, replacement: resolve(root, "../core/src/index.ts") },
      { find: "@uifn/svelte", replacement: resolve(root, "./src/test-utils/uifn-svelte-stub.ts") },
      { find: "@searchfn/client", replacement: resolve(root, "../../searchfn/client/src/index.ts") },
      { find: "@searchfn/core", replacement: resolve(root, "../../searchfn/core/src/index.ts") },
      { find: "@searchfn/adapter-contracts", replacement: resolve(root, "../../searchfn/adapter-contracts/src/index.ts") },
      { find: "@searchfn/adapter-memory", replacement: resolve(root, "../../searchfn/adapter-memory/src/index.ts") },
      { find: "@searchfn/adapter-indexeddb", replacement: resolve(root, "../../searchfn/adapter-indexeddb/src/index.ts") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
