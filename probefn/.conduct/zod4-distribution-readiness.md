# Zod 4 distribution checkpoint

Probe's four direct Zod declarations now require `^4.6.6`; the normal workspace installation resolved 4.6.7. The [published oversized-collection advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) identifies 4.6.6 as the patched floor. This is an actual Zod 4 runtime migration, without the Zod 3 compatibility entry point.

Configuration defaults use `prefault` to preserve parsed nested defaults, rather than Zod 4's short-circuit output default behavior. Records declare string keys explicitly. MCP object schemas use `strictObject`; validation preserves missing-field error envelopes while projecting only path/message, never raw invalid input. Consumers extending schema helpers must use Zod 4 types. The [upstream migration guide](https://zod.dev/v4/changelog) describes these API changes.

The separate McpFn prerequisite is f9fef208ddff3095629667d190c3637a61ef3aed: fast-uri 3.1.9 with narrow anonymous-root compatibility. Its existing CF-worker encoded-separator pointer limitation remains explicit in the McpFn receipt.

## Validation

Node 22.22 and normal npm 11 scoped installation, without force, peer bypass, overrides or audit threshold changes:

- `npm install --workspace=@probefn/workspace --workspace=@probefn/contracts --workspace=@probefn/storage --workspace=@probefn/mcp-server --no-fund`: passed. The lock changes are the four declarations and one Probe-local Zod package entry.
- `turbo run build typecheck --filter=@probefn/workspace --filter=@probefn/admin`: 15 tasks passed. Final typecheck invocation also rebuilt dependency outputs: 14 tasks passed after compatibility test additions.
- Focused configuration/MCP compatibility: 9 tests passed. Covers nested defaults, trimmed named-server records, malformed records/null settings, safe-integer storage bounds, strict unknown-key rejection, missing versus wrong-type inputs and secret-free errors.
- Full original source workload in an isolated copied root: 49 files, 277 tests passed in 98.23 seconds. Native browser lifecycle, independent-process quota/event/scratch recovery and existing MCP envelope assertions remain enabled. No timeout or workload reduction.
- `PROBEFN_PLAYWRIGHT_VERSION=1.57.0 PROBEFN_NPM_CLI=<normal npm 11 CLI> node probefn/scripts/verify-distribution.mjs --browser`: passed. Thirteen actual tarballs, fresh normal install, CLI/MCP stdio, scoped administration, configuration defaults and malformed MCP arguments, strict installed TypeScript consumer, three event-journal SIGKILL stages, six trace-registry SIGKILL boundaries, Chromium 143 real capture/traces/WebM, ownership fencing and artifact/event caps. Final production audit: **zero vulnerabilities**.

Receipts: `/tmp/probe-zod4-install.log`, `/tmp/probe-zod4-build-types.log`, `/tmp/probe-zod4-final-types.log`, `/tmp/probe-zod4-focused.log`, `/tmp/probe-zod4-full.log`, `/tmp/probe-zod4-full-copy.json`, `/tmp/probe-zod4-packed.log`.

The isolated source copy and fresh installed consumer were removed after terminal checks. Existing synthetic `run_hmr` evidence and original artifact coordinator files were preserved. The prior registry checkpoint's failed distribution audit remains recorded; this checkpoint closes that specific fresh-distribution gate. It does not claim the entire monorepo audit is clean, nor close physical scratch hard-quota/platform gaps or unknown-producer reclamation.
