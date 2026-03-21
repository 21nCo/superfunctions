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
  esbuildPlugins: [
    esbuildSvelte({
      compilerOptions: {
        warningFilter: (warning) => warning.code !== "state_referenced_locally",
      },
      filterWarnings: (warning) => warning.code !== "state_referenced_locally",
    }),
  ],
  treeshake: true,
  minify: false,
});
