import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const scaleTests = "tests/openapi-scale.test.ts";

export default defineConfig({
  resolve: {
    // src/openapi imports the root entry by package name (see tsup.config.ts).
    alias: [
      { find: /^@mcpfn\/core$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: [scaleTests] } },
      // Timing bounds run on their own, after every other test file.
      { extends: true, test: { name: "scale", include: [scaleTests], sequence: { groupOrder: 1 } } },
    ],
  },
});
