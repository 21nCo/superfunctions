import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { bundledSdkBanner } from "../../scripts/verify-mcpfn-bundled-sdk.mjs";

const require = createRequire(import.meta.url);
const zodRoot = dirname(require.resolve("zod/package.json"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Inline the MCP SDK and its Zod runtime so consumer bundles (notably
  // Cloudflare Workers) never resolve `zod/v4` as a separate entry point.
  // A mixed `zod` (consumer root) + `zod/v4` (SDK) graph lets esbuild emit an
  // initialization order that throws `Class2 is not a constructor` at workerd
  // startup; a self-contained bundle removes that hazard without any
  // consumer-local alias. See mcpfn/ADR-0001-COMPATIBILITY.md.
  // Resolve every SDK Zod subpath from this package's pinned build input.
  // Other workspaces may legitimately retain a different hoisted Zod version.
  esbuildOptions(options) {
    options.alias = { ...options.alias, zod: zodRoot };
  },
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
  // Stamp the inlined SDK version into each bundle; the build and the
  // bundled-SDK test check it against the exact pin (MCP-13).
  banner: { js: bundledSdkBanner(dirname(fileURLToPath(import.meta.url))) },
});
