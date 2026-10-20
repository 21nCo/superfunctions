import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/operator.ts", "src/react.ts", "src/svelte.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  treeshake: true,
  splitting: false,
});
