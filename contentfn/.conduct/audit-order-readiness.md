# Audit query ordering — 2026-10-23

Additive prerequisite for CmsFn's original audit pane requirement (descending
timestamps, ascending identity ties). `AuditQuery.order` accepts `asc` or `desc`;
omission preserves the existing ascending timestamp default. Both orders keep
ascending `id` ties. The server rejects other values, including null, before
querying storage. The typed core export flows through the existing client and
server audit APIs; no schema migration or default behavior change is required.

Validation: four focused audit integration tests pass on Node 22.22.0, including
SQLite reopen/rollback, actual HTTP authorization, scheduled publication and the
new order/default/tie/pagination/invalid-value cases. The first run on system Node
20.20.0 hit the existing better-sqlite3 ABI mismatch (compiled for Node 22); it
was rerun with the matching interpreter, with no dependency rebuild. Server
`typecheck`, core/server/client builds and `git diff --check` pass.

Commands: `npx --yes --package=node@22.22.0 node node_modules/vitest/vitest.mjs
run --root contentfn/server src/__tests__/audit.integration.test.ts`;
`npm run typecheck --workspace=@contentfn/server`; `npm run build` with each of
`--workspace=@contentfn/core`, `--workspace=@contentfn/server`,
`--workspace=@contentfn/client`.

Receipts: `/tmp/content-audit-order-focused-node22-oct23.log`,
`/tmp/content-audit-order-types-oct23.log`, and
`/tmp/content-audit-order-{core,server,client}-build-oct23.log`.
CmsFn will separately verify the installed producer/consumer contract. Offset
pagination is deterministic for a stable dataset; it is not snapshot pagination
under concurrent insertions. No full ContentFn suite, external provider call,
push or deployment was performed for this additive change.
