import { defineConfig } from "tsup";

export default defineConfig({
  // `testfn` is a separate entry so that only `@apifn/core/testfn` imports the
  // optional `@testfn/core` peer; nothing reachable from `index` may import it.
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    "openapi-reference-context": "src/openapi/reference-context.ts",
    testfn: "src/integrations/testfn.ts",
  },
  format: ["cjs", "esm"],
  external: ["@apifn/collections"],
  dts: true,
  clean: true,
  sourcemap: true,
});
