# Dataset webhook delivery audit and schema4 upgrade

ContentFn now exposes `POST /contentfn/audit/webhooks` and typed
`server.api.audit.webhooks` / `client.audit.webhooks`. Authorization receives
`audit.webhooks` and the requested dataset through the existing policy boundary.
This is an additive dataset-wide query; `/contentfn/webhooks/deliveries` retains
its existing per-hook ownership check, including denial after hook deletion.

The result is `{ records, nextOffset }`, with limit 1–1000 (default 100) and a
nonnegative safe offset. Records are the latest durable state of each event/hook
delivery, including attempt count, processing/pending/delivered/failed status,
last error, safe destination, and transition timestamp. Attempt count includes
reserved attempts, as in the existing lease protocol. This does not invent a
separate record of every historical attempt. Known timestamps sort descending,
then unknown legacy times; identity sorts ascending within ties. Offset pages
are deterministic for unchanged data, not a snapshot across concurrent state
changes. There is no arbitrary first 100 aggregation or per-hook join at read time.

Schema4 adds nullable dataset, destinationUrl, updatedAt, timestampKnown and
auditMetadataVersion columns to the queue. New enqueues persist provenance and
safe destination inside the existing event/mutation transaction. Claims and
results update actual transition time without changing lease/CAS semantics.
Destinations omit username, password, query and fragment in audit storage and
projection; delivery uses the original registered URL. Hook deletion retains
known delivery history; dataset deletion removes it. A worker finding a missing
hook/event still stops retrying, but now records terminal `failed` with an explicit
“delivery was not attempted” reason and increments the failed summary count. It
never labels a no-send path `delivered`; the transition retains the lease guard. No raw document body or
webhook signing secret is included.

## Upgrade existing schema3 databases

1. Drain and stop **all old API servers and webhook workers**. Keep legacy writers
   stopped throughout migration and after enabling schema4. A new option cannot
   fence a binary that does not implement it: the host acknowledgement below is
   a deployment contract, not distributed exclusion. Old inserts after migration
   are detected as incomplete metadata; old updates to a previously migrated row
   cannot reliably be detected and are unsupported.
2. Apply additive schema4 DDL before starting any new writer. Shared CLI discovery
   (`getSchema`, package schemaVersion4; `npx superfunctions generate`) includes
   the five nullable columns. Apply the generated migration with the host ORM's
   migration tool. Alternatively call exported `upgradeWebhookAuditSchema` with
   a host `addColumnIfNotExists(table, name, ColumnDef)` implementation. It awaits
   each nullable column addition and is restartable after partial DDL. Existing
   create-only `runContentfnMigrations` adapters still work for fresh databases;
   that baseline function **does not alter an existing table**.
3. Call exported `backfillWebhookAudit({ db, jsonStorage? },
   { legacyWritersStopped: true, limit: 100, afterId? })` using the ordinary shared
   Adapter. The function wraps its own schema. Each bounded page runs in a
   transaction, resolves provenance from event/hook, and uses a row timestamp CAS
   so a concurrent schema4 transition is not overwritten. Follow `nextId` until
   null. On failure retry the same page. Restart from the beginning if `ready` is
   false after the last page (including a row skipped by CAS).
4. Resolve `unresolvedIds` from authoritative retained history/backups. An event
   or hook alone can establish dataset; conflicting datasets or absence of both
   cannot. Restore verified provenance or use an explicitly audited host data
   repair; never invent a dataset, event timestamp or destination. Re-run from the
   beginning after reconciliation. `ready:true` means no unbackfilled queue row
   remains at that transaction boundary, not that old writers have been fenced.
5. Start only schema4 code and configure
   `createContentfnServer({ db, webhookAuditWriterSchemaVersion: 4, authorize })`.
   Without the acknowledgement, or while any queue row has uninitialized metadata,
   the dataset audit route returns `STORAGE_ERROR` with
   `details.reason = "WEBHOOK_AUDIT_NOT_READY"`. The conservative global gate avoids
   reporting a complete dataset page when a legacy row's dataset is unknown.
   Legacy per-hook inspection/delivery remains available after DDL.

Backfilled rows have `updatedAt:null` / `timestampKnown:false` unless a schema4
worker already recorded a real transition. A missing deleted hook produces
`url:null`, not a fabricated destination. `nextRunAt` is never used as a past
timestamp: it may be a future retry or lease deadline.

## Validation

- Full Content server suite on Node22.22: 198 tests passed; two existing external
  SQL service tests skipped because their services were not requested.
- Native SQLite schema3 → schema4: repeatable ALTER upgrade, injected page rollback,
  105 legacy rows across bounded pages and database reopen, idempotent rerun,
  actual new-worker transition preservation, unknown time and deleted-hook
  recovery, conflicting provenance rejection, old-insert re-gating and bounds.
- Existing signed local HTTP delivery, retry, SQLite reopen and lease/attempt
  ceiling test passes unchanged with the additive metadata.
- Core 21 and client 5 tests passed. Missing-hook/event regressions prove no sends,
  no fabricated success, terminal retry behavior and stale-lease denial.
- Server typecheck and core/server/client ESM/CJS/declaration builds pass.
- Fresh normal npm11 packed CMS/Content acceptance traverses 105 actual deliveries
  in three CMS HTTP pages, performs local HTTP delivery, checks safe projection,
  deleted-hook history, dataset deletion and trusted identity/denial boundaries.
  Production-only install audit: zero vulnerabilities. No provider sends.

Logs: `/tmp/content-webhook-{types,full-final,focused-final,core-build,server-build,client-build}.log`
and `/tmp/cms-webhook-{packed-install,packed-http,production-audit}.log` (audit is
`.json`). SQLite fixture directories and owned packed installs are removed after
validation; logs remain. This checkpoint does not certify external SQL services,
live deployment migration, or concurrent offset pages as a snapshot.
