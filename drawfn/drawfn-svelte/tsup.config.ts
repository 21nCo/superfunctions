import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2021",
  minify: false,
  splitting: false,
  treeshake: true,
  outDir: "dist",
  external: ["svelte", "svelte/store"],
});
