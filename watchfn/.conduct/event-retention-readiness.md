# Canonical event retention and bug TTL

Watch's original database-tier example and RetentionManager use a 30-day default. Catch's original Persistence & Storage section requires inheriting that retention with a bug-report TTL override. The canonical shared database path now supports an explicit server policy and bounded cleanup. It reuses the existing 30-day retention constant. No cleanup route, automatic timer, or client-supplied policy is introduced.

```ts
const watch = new WatchFn({
  name: "shop",
  storage: "database",
  database,
  retention: {
    apps: ["shop"],             // fixed trusted application allowlist
    defaultTtlMs: 30 * 86400000, // optional; defaults to 30 days
    bugReportTtlMs: 90 * 86400000, // optional; inherits defaultTtlMs
  },
  // Existing authentication and optional BotFn server configuration...
});
watch.start();
let after: string | undefined;
do {
  const page = await watch.cleanupRetention({ after, limit: 100 });
  after = page.nextCursor ?? undefined;
} while (after !== undefined);
```

The host must schedule complete passes. Each call scans 1–1000 storage IDs, default 100, and returns scanned/deleted/retained counts plus a progress cursor. A retained-only or full final page can still have a cursor; follow it until null. Start future scheduled passes from the beginning to catch arrivals inserted before an earlier cursor. This is live keyset traversal, not a database snapshot or a hard bound on total runtime. Each deletion is rechecked in a shared database transaction; the configured app must match the authoritative top-level payload, and trusted server `receivedAt` must be strictly older than the applicable TTL. Both arrival timestamps and cleanup cutoffs use the application host's `Date.now()`, not the database server clock. Keep all ingest/cleanup host clocks synchronized; this does not promise clock-skew immunity. Clients' timestamp/receivedAt fields and properties-level application claims do not govern cleanup. Missing/invalid/future arrival metadata and absent/unconfigured apps are retained.

Configuration is opt-in and requires a transactional shared adapter. Memory and legacy storage modes reject it; a shared memory adapter is only a contract-test backend, not durability evidence. The application allowlist is copied, and TTLs must be positive safe integer milliseconds. It is an operator boundary within the existing single-trusted-application deployment model, not new API-key tenancy. Events without canonical top-level app identity remain untouched, so general metric/hybrid-tier retention is still open.

## Issue delivery safety

All `bug_` storage IDs are protected unless exactly one corresponding outbox receipt is terminal `linked`, belongs to this configured BotFn namespace and matches the canonical app/report ID. Receipt target/project/issue ID/URL must also agree with the linked canonical payload; incomplete or inconsistent linkage remains protected. Pending, processing, reconciliation, missing receipts, unexpected duplicate receipts, foreign namespaces, and cleanup without a configured BotFn namespace remain protected regardless of age. Provider reconciliation evidence is not removed to satisfy a TTL.

Only the linked event payload expires. Its durable outbox fingerprint, routing identity, provider link and status remain indefinitely. An exact replay is acknowledged by the existing receipt without recreating the event or provider issue; changed content still conflicts. Verified issue status remains available. Do not purge outbox receipts or change namespaces as part of this payload policy: that would discard deduplication history. Receipt retention/privacy and archival policies need a separate operational design. Unresolved payloads may exceed their TTL indefinitely until their delivery state is resolved. Ordinary events without an outbox retain their existing at-least-once replay behavior.

Failures reject the cleanup call. A page can have committed earlier deletions before a later failure; rerun from the last successful cursor or the beginning safely. No successful page/count is returned for a failed page. Cleanup admitted by Watch participates in existing flush/stop ownership: stop waits for it, and storage failures remain observable through flush. Database operations must eventually settle; no storage-operation timeout is claimed.

## Existing databases

Apply the additive nullable column before starting the new writer, even when cleanup is disabled:

```sql
ALTER TABLE watchfn_events ADD COLUMN receivedAt INTEGER;
```

Use a 64-bit integer or equivalent exact millisecond numeric column in other dialects. There is no default value: new writes set server time atomically with the payload, including canonical BotFn transactions. Issue linking and duplicate receipt replay never reset arrival time. Existing rows remain protected with null arrival time.

If historical rows should become eligible, stop writers, workers, queries and cleanup, select one explicit migration anchor (normally migration start time), and initialize null values with the bounded utility:

```ts
const storage = new DatabaseStorage(database);
const receivedAt = Date.now(); // persist once and reuse after interruptions
let after: string | undefined;
do {
  const page = await storage.backfillReceivedAt({ receivedAt, after, limit: 100 });
  after = page.nextCursor ?? undefined;
} while (after !== undefined);
```

Never derive this anchor from client event timestamps. An earlier operator-selected anchor can intentionally make historical rows immediately eligible; the operator must authorize that retention consequence. The anchor must be a nonnegative safe integer no later than server now. Initialization updates only null values, preserves existing receipt times and payloads, is resumable/idempotent, and fails on a missing column before any writes. Persist the cursor only after a successful page; interrupted pages may have initialized some rows and can be repeated with the same anchor. Malformed non-null timestamps remain protected and require explicit data repair. Complete migration before resuming cleanup.

## Evidence and limits

All 188 core source tests, TypeScript checks and CJS/ESM/declaration builds pass. Nine focused retention tests exercise 30-day inheritance and bug override, exact TTL boundary, client timestamp/metadata spoofing, fixed app scope, unknown historical metadata, deterministic anchor initialization, bounded retained-only pages, linked-payload replay/conflict/status, unresolved/foreign/missing receipts, interrupted deletes and stop/flush behavior.

All three native BotFn scenarios pass. Native SQLite and actual local HTTP acceptance uses the real BotFn GitHub client. A future-dated client report expires according to server arrival; its exact replay after close/reopen does not recreate a payload or remote issue, conflicting replay returns 409, and the durable linked status remains. A pending report and a different application survive cleanup; the pending report expires only after linking. A second reopen confirms deleted payloads stay deleted and both receipt tombstones remain. No external provider issue/message is created.

The old-schema migration scenario initializes arrival metadata on 1005 existing records through bounded pages and verifies retry does not reset timestamps. Broad-query scalability, automatic scheduling/operations, receipt archival, general non-app metric retention, hybrid tiers, hosted database behavior and production deployment remain open. This is canonical retention progress, not overall Watch/Catch readiness.

Validation commands from the repository root: `npm test --workspace @watchfn/core`, `npm exec --workspace @watchfn/core -- tsc --noEmit`, `npm run build --workspace @watchfn/core`, and `npm exec --workspace @watchfn/core -- vitest run --config tests/integrations/botfn-sqlite.config.ts`. The 1005-row migration test uses `tests/storage/event-indexes-sqlite.config.ts`. Native tests require Kysely and a working local better-sqlite3 binding.
