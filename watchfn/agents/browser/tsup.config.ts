import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm", "iife"], // IIFE for script tag usage
  globalName: "WatchFn",
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
});
