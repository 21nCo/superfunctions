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

That SQLite unit fixture sets expired lease state directly and does not kill a
running worker. The separate process-crash acceptance below now exercises actual
worker termination. Neither proves multi-host/database-dialect guarantees. Receivers still need
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


## Actual worker termination acceptance — 2026-10-22

`webhook-process-crash-acceptance.mjs` runs the built `createContentfnServer` in
owned child processes against native file-backed better-sqlite3/Kysely and a
real localhost HTTP receiver. It initializes datasets, schema, document and
webhook through the built public API. It does not write queue state, alter lease
expiry, inject attempts, replace fetch, or use fake clocks/timers.

The receiver reads the complete signed request, verifies HMAC-SHA256, and applies
an eventId-deduplicated logical action. It deliberately sends no response. The
parent verifies the durable `processing` row with reserved attempt 1 and future
lease, sends SIGKILL to that exact worker PID, awaits exit with signal SIGKILL
and no exit code, and reopens SQLite. The reserved row survives byte-for-field
unchanged. Another fresh worker before lease expiry does no work and sends
nothing. Recovery waits for actual persisted wall-clock expiry.

- **Below cap (`maxAttempts: 2`):** worker PID 58060 was killed. After a real
  5271 ms wait, a fresh worker delivered attempt 2. Both HTTP bodies and HMACs
  were identical, eventId matched, and receiver deduplication kept one logical
  application despite two requests. Reopening again preserved delivered state
  and made no extra request.
- **At cap (`maxAttempts: 1`):** worker PID 58529 was killed. After a real
  5273 ms wait, two independent reopened workers settled the entry exactly once
  as failed at attempt 1. Only the original request reached the receiver. The
  stored error explicitly states the last delivery outcome may be unknown.
  Reopening again preserved that state and made no extra request.

The receiver had applied the logical action before each kill, while the sender
never saw an acknowledgment. Thus terminal failure does not mean non-delivery,
and retry below the cap can duplicate delivery. The fixture's in-memory receiver
Set demonstrates eventId deduplication across producer restarts; it does not
prove durable receiver deduplication or exactly-once delivery.

Full machine receipt: `webhook-process-crash-receipt-20261022.json`. ESM,
CommonJS and declarations were rebuilt from current source before execution.
Runtime was Node v22.23.3, matching the installed SQLite native binary; this
adds no Node 20 native acceptance. No source defect was reproduced and no
production implementation, dependency or lockfile was changed. All owned child
processes exited, both local receivers closed, and temporary database-directory
removal was read back as ENOENT before the success receipt was emitted.

Reproduce from the checkout root after building `@contentfn/server`:

```sh
/path/to/matching-node22 contentfn/.conduct/webhook-process-crash-acceptance.mjs
```

Logs from this run: `/tmp/content-crash-build.log` and
`/tmp/content-process-crash.log`. External provider delivery, multi-host recovery,
non-SQLite dialects, queue scan bounds and wider production requirements remain
unverified.
