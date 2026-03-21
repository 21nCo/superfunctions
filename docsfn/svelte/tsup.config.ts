import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import esbuildSvelte from "esbuild-svelte";
import { SVELTE_PUBLIC_TYPES } from "./src/public-types";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ["svelte", "@docsfn/core", "@uifn/svelte", "searchfn", "marked"],
  esbuildPlugins: [esbuildSvelte()],
  onSuccess: async () => {
    await writeFile(
      path.join(dirname, "dist/index.d.ts"),
      SVELTE_PUBLIC_TYPES,
      "utf8"
    );
  },
});
