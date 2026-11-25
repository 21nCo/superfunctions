import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const scaleTests = "tests/openapi-scale.test.ts";
// fromOpenAPI tests with wall-clock bounds; they must not share the CPU with the bundle-scanning suites.
const timedTests = "tests/openapi-forms.test.ts";
// fromOpenAPI under @cfworker/json-schema: long synchronous conversions of 2,500-link chains, run in their own group.
const cfworkerTests = "tests/openapi-cfworker.test.ts";

export default defineConfig({
  resolve: {
    // src/openapi imports the root entry by package name (see tsup.config.ts).
    alias: [
      { find: /^@mcpfn\/core$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["tests/yield-between-tests.ts"],
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: [scaleTests, timedTests, cfworkerTests] } },
      // Timing bounds run on their own, after every other test file.
      { extends: true, test: { name: "timed", include: [timedTests], sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: "scale", include: [scaleTests], sequence: { groupOrder: 2 } } },
      { extends: true, test: { name: "cfworker", include: [cfworkerTests], sequence: { groupOrder: 3 } } },
    ],
  },
});
