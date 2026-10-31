import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { bundledInputs } from "../core/scripts/bundled-inputs.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const { zodRoot, plugin } = bundledInputs(packageRoot);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
  // Inline the MCP SDK and its Zod runtime so consumer bundles (notably
  // Cloudflare Workers) never resolve `zod/v4` as a separate entry point next to
  // a root `zod` import. See mcpfn/ADR-0001-COMPATIBILITY.md.
  // Every SDK Zod subpath must use this package's pinned build input, even
  // when another workspace retains an older hoisted Zod installation.
  esbuildOptions(options) {
    options.alias = { ...options.alias, zod: zodRoot };
  },
  esbuildPlugins: [plugin],
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
});
