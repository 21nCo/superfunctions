# Webhook attempt limits across storage reopen

An expired processing lease previously bypassed `webhooks.maxAttempts`: a restarted
worker could send again after the final attempt had already been reserved. The queue
now conditionally settles an exhausted due entry as failed without another request
or incrementing its attempt count. Matching the complete observed lease state keeps
concurrent workers from overwriting a newer owner or counting the settlement twice.
The failure text states that the last delivery outcome may be unknown.

Native acceptance in `server/src/__tests__/webhooks.sqlite.test.ts` uses file-backed
better-sqlite3/Kysely, actual local HTTP and HMAC-SHA256 verification. A published
document produces a signed delivery; HTTP 503 persists attempt 1; reopening SQLite
preserves it; HTTP 204 retry sends identical bytes/signature and persists delivered
attempt 2 across another reopen. A persisted expired final processing lease then
settles once across two independent SQLite connections without another HTTP send.
The exhausted case failed before the fix by sending attempt 3.

This fixture sets the expired lease state directly; it does not kill a running
worker. It proves durable state recovery and the attempt ceiling, not a full process
crash acceptance or multi-host/database-dialect guarantees. Receivers still need
eventId deduplication. Pending queue scan bounds and wider webhook/security/runtime
requirements remain open.

Validation on 2026-10-22: Node 22 native suite passed 190 tests across 25 files, with
2 existing skipped cases in one file; server typecheck and ESM/CommonJS/declaration
builds passed. The focused webhook/native suite was rerun after adding concurrent
exhaustion settlement. Default Node 20 could not load the existing Node 22 SQLite
binary; the native tests ran under the matching Node 22 runtime. This is not new
Node 20 acceptance. Local receiver, databases and temporary directories are removed.

The task branch also incorporates shared prerequisite f0d620096 through an ordinary
merge. Rebuilt observability, DB, HTTP, storage, Markdown core/extensions/ContentFn/
parser, ContentFn core and server in dependency order, then repeated the full server
suite and typecheck. Turbo was absent in this checkout, so npm workspace build
commands were used; no package or toolchain bypass was introduced.
