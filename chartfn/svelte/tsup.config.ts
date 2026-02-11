import { defineConfig } from "tsup";
import sveltePlugin from "esbuild-svelte";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  splitting: false,
  clean: true,
  esbuildPlugins: [sveltePlugin()],
});
