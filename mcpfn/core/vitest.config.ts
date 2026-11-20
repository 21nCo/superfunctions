import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // src/openapi imports the root entry by package name (see tsup.config.ts).
    alias: [
      { find: /^@mcpfn\/core$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
