import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/failure-event.ts"],
  format: ["cjs", "esm"],
  external: ["@apifn/core"],
  dts: true,
  clean: true,
  sourcemap: true,
});
