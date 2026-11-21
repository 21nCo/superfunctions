import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";
import { bundledSdkBanner } from "../../scripts/verify-mcpfn-bundled-sdk.mjs";

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
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
  // Stamp the inlined SDK version into each bundle; the build and the
  // bundled-SDK test check it against the exact pin (MCP-13).
  banner: { js: bundledSdkBanner(dirname(fileURLToPath(import.meta.url))) },
});
