# Bundled MCP schema runtime security

McpFn bundles the MCP SDK and Zod into its ESM/CJS runtime. A clean installed dependency audit alone did not inspect the old Zod 3.25.76 bytes embedded during the workspace build. The build input now pins Zod 4.6.6, and esbuild resolves the package and all subpaths from that exact local dependency. Unrelated workspace Zod versions remain unchanged. SDK 1.32.1 declares compatibility with `^3.25 || ^4.0`.

The SDK source imports `zod`, `zod/v3`, `zod/v4`, and `zod/v4-mini`; the package alias applies to all of them. The actual retained McpFn ESM and CJS bundles each contain 19 Zod v4 source files; unused SDK compatibility branches are tree-shaken. The build now verifies every retained Zod source-map entry is inside the pinned package and its embedded source bytes equal the installed source. It fails on foreign hoisted sources, missing runtime sources, or an unexpected version. Both `noExternal` inputs remain the SDK and Zod.

Validation on October 25, 2026, Node 20.20.0:

- Normal npm 11.21.0 scoped install succeeded without peer bypasses. Generated lock changes are only the McpFn build pin and its nested 4.6.6 placement; unrelated root Zod remains intact. Existing unrelated workspace engine warnings were emitted.
- McpFn TypeScript check and build passed; all 266 tests across 7 files passed.
- `node mcpfn/core/scripts/verify-bundled-zod.mjs` verified both generated source maps.
- `node mcpfn/core/scripts/packed-runtime-acceptance.mjs` normally installed fresh McpFn/shared-admin tarballs; ESM/CJS schema validation, actual linked MCP client/server calls, HTTP initialization and admin imports passed. Production audit: zero vulnerabilities. Its owned temporary consumer was removed in `finally`.

This is separate from the fast-uri 3.1.9 prerequisite and the unused Flow Zod dependency removal. It does not assert that unrelated workspace dependencies or all host runtimes are secure. Zod advisory: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 (patched 4.6.6).
