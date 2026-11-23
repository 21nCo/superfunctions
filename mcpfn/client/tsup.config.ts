import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    stdio: "src/stdio.ts",
    "stdio-unavailable": "src/stdio-unavailable.ts",
  },
  format: ["esm", "cjs"],
  // Inline the oauth-core redaction option types too: the package is a
  // build-time dependency only (see noExternal below).
  dts: { resolve: ["@superfunctions/oauth-core"] },
  sourcemap: true,
  clean: true,
  splitting: false,
  // The MCP SDK stays external. The main entry (`index`) is remote-only and
  // runs on Cloudflare Workers; the stdio transport, which spawns servers via
  // `cross-spawn` and `node:child_process`, is only in the `stdio` entry.
  // `#stdio-target` is resolved at runtime through package.json `imports`:
  // `node` gets the stdio entry, every other runtime gets `stdio-unavailable`.
  external: ["#stdio-target"],
  // Inline the redaction helper: tree-shaking drops the package's unused
  // top-level `crypto` import, so the remote entry has no Node built-ins and
  // runs on workerd without `nodejs_compat`.
  noExternal: ["@superfunctions/oauth-core"],
});
