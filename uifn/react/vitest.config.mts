import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { packageReactAliases } from "../../scripts/vitest-package-react.mjs";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    conditions: ["browser"],
    alias: packageReactAliases(fileURLToPath(new URL(".", import.meta.url))),
  },
});
