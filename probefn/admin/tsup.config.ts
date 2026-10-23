import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  shims: true,
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["jiti"],
});
