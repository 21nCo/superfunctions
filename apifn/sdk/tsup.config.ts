import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  // Inline the published catalog schema so dist reads no JSON at runtime.
  noExternal: [/^@apifn\/contracts\/schemas\//],
  dts: true,
  clean: true,
  sourcemap: true,
});
