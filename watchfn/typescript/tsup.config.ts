import { defineConfig, type Options } from "tsup";

const shared: Options = {
  dts: true,
  sourcemap: true,
  target: "es2022",
  // Never bundle shared packages: consumers resolve them from their own node_modules.
  external: ["@superfunctions/http", "@superfunctions/db"],
};

// `npm run build` empties dist first; tsup's own clean would race the second build.
export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts", sqlite: "src/sqlite.ts", collectors: "src/collectors.ts" },
    format: ["cjs", "esm"],
  },
  {
    // @superfunctions/http ships ESM only, so the HTTP routes do too.
    ...shared,
    entry: { http: "src/http.ts" },
    format: ["esm"],
  },
]);
