# Shared MCP security integration

Integrated the fast-uri3.1.9 anonymous-schema prerequisite and pinned bundled Zod4.6.6 build input onto Shared2a907aeabc279b156415061bc0e79dd71347236a. The Zod cherry-pick lock conflict was resolved by retaining Shared's existing Vitest placement and adding only the McpFn dependency pin/nested Zod entry. A normal npm11 lock-only resolution succeeded; its unrelated libsql metadata-only change was restored. No unrelated package versions changed.

The initial incremental scoped install failed in npm11.21 Arborist overrideMatchesSubtree/edgesOut before compilation or testing. A clean scoped npm11 CI install of McpFn/core and shared/admin succeeded with317 packages, lifecycle scripts disabled, and no peer bypass. This known populated-tree npm failure remains a tooling limitation, not a runtime test pass.

Current merged-tree validation on Node20.20:

- McpFn strict types,266 tests and ESM/CJS/declaration build pass.
- Shared admin rebuilt;109 tests pass.
- Both generated bundles retain19 Zodv4 sources from the pinned4.6.6 package, and their source-map content matches those source bytes exactly. An owned negative check altered one embedded source-map entry: the guard rejected it; original bytes were restored and the guard passed again.
- Fresh McpFn/admin tarballs installed outside the checkout pass ESM/CJS schema validation, linked actual MCP client/server calls, actual HTTP initialization and admin imports. Production dependency audit:zero. The fixture removed its owned consumer in finally.
- Clean Git status before this receipt; generated distribution files excluded.

Receipts: /tmp/shared-mcp-security-{lock,install,ci,types,tests,build,admin-build,admin-tests,packed,guard-negative,guard-restored}.log. The failed install receipt is retained separately from the successful CI result.

The Zod advisory identifies4.6.6 as patched: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5. The fast-uri advisories and anonymous-root compatibility evidence are in mcpfn/.conduct/fast-uri-security-readiness.md. Existing CF-worker encoded-separator pointer support remains incomplete. This checkpoint does not claim full-monorepo audit success, all host-runtime coverage, hosted CI or downstream branch integration. Function branches must rebuild their actual bundles after incorporating this prerequisite.
