# Dev runtime reconciliation — October 28, 2026

PR #244 was reconciled with `origin/dev` at `ad5a06fb5`. Its lockfile conflict was resolved by using the current dev lock as the starting point and regenerating against merged manifests with npm 11; package versions and new upstream workspaces were retained. No base merge or release was performed.

The draft also receives the targeted runtime corrections already validated on the shared next branch: fast-uri 3.1.9 with anonymous-schema root handling, canonical encoded JSON Pointer fragments in the code-generation-free validator, and pinned Zod 4.6.6 as the actual bundled SDK parser. Build aliases bind SDK subpaths to that input; the post-build verifier compares source-map retained bytes to the pinned files for both ESM and CommonJS. Root Zod remains independently pinned for other consumers. This does not import unrelated next-only MCP transport/profile changes.

## Current validation

- Clean scoped npm 11 CI installation for `@mcpfn/core` and `@superfunctions/admin` succeeded (423 packages).
- `npm exec -- turbo run build typecheck test --filter=@mcpfn/core --filter=@superfunctions/admin --concurrency=1`: six tasks passed without cache hits. Core: 281 tests/7 files; admin: 109 tests/7 files. Both formats/declarations and bundled parser provenance passed.
- `node mcpfn/core/scripts/packed-runtime-acceptance.mjs`: fresh isolated tarball consumers passed ESM/CommonJS, Ajv and cfworker encoded-pointer validation, official-client tool discovery/calls, HTTP initialization and admin cursor checks on Node 22.13.0. Production audit reported zero advisories. Temporary consumer was removed.
- A separate fresh installed core tarball passed four format/engine matrices (nine cases each) and nine cases in actual local workerd with automatic cfworker selection and runtime code generation confirmed blocked. It covered encoded separators, literal percent sequences, escaped tokens, Unicode, spaces, external resources and rejection of double-decoded pointers. Owned process was stopped and temporary installation removed.
- Full-workspace npm 11 CI dry-run succeeded. This validates lockfile installation planning, not all workspace runtimes.
- `git diff --check` passed.

Local receipts: `/tmp/mcp-dev-ci-20261028.log`, `/tmp/mcp-dev-checks-20261028.log`, `/tmp/mcp-dev-packed-20261028.log`, `/tmp/mcp-dev-worker-20261028.log` and `/tmp/mcp-dev-full-plan-20261028.log`. The local workerd matrix runner is `/tmp/mcp-dev-worker-acceptance-20261028.py`.

## Limits

This pass used Node 22.13.0. Historical Node 18/20 evidence is not represented as a rerun of this candidate. Hosted CI, every consumer's runtime matrix and registry post-publication validation remain open. Existing unrelated dependency graphs are not claimed security-clean. No deployment or account resource was created.
