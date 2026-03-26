import { defineConfig } from "tsup";
import esbuildSvelte from "esbuild-svelte";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ["svelte", "@uifn/core"],
  esbuildPlugins: [esbuildSvelte()],
  treeshake: true,
  minify: false,
});
