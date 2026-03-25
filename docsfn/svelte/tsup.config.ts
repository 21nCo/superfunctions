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
  external: [/^@docsfn\/core(\/.*)?$/, "svelte", "@uifn/svelte", "searchfn", "marked"],
  esbuildPlugins: [esbuildSvelte()],
  onSuccess: async () => {
    const { copyFile } = await import("node:fs/promises");
    await writeFile(path.join(dirname, "dist/index.d.ts"), SVELTE_PUBLIC_TYPES, "utf8");
    await copyFile(path.join(dirname, "src/theme.css"), path.join(dirname, "dist/theme.css"));
    await copyFile(
      path.join(dirname, "src/theme-base.css"),
      path.join(dirname, "dist/theme-base.css")
    );
  },
});
