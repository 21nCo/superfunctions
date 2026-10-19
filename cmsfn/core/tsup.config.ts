import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2021",
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: "dist",
  // These shared packages are ESM-only; bundle them for Node 18 CJS consumers.
  noExternal: ["@superfunctions/envelope", "@superfunctions/errors"],
});
