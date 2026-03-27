import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@docsfn/core/browser", replacement: resolve(root, "../core/src/browser.ts") },
      { find: "@docsfn/core", replacement: resolve(root, "../core/src/index.ts") },
      { find: "@searchfn/client", replacement: resolve(root, "../../searchfn/client/src/index.ts") },
      { find: "@searchfn/core", replacement: resolve(root, "../../searchfn/core/src/index.ts") },
      { find: "@searchfn/adapter-contracts", replacement: resolve(root, "../../searchfn/adapter-contracts/src/index.ts") },
      { find: "@searchfn/adapter-memory", replacement: resolve(root, "../../searchfn/adapter-memory/src/index.ts") },
      { find: "@searchfn/adapter-indexeddb", replacement: resolve(root, "../../searchfn/adapter-indexeddb/src/index.ts") },
      { find: "@uifn/react", replacement: resolve(root, "./src/test-utils/uifn-react-stub.tsx") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
