# Canonical event indexes and migration

The canonical event table now declares the indexes required by CatchFn's original Persistence & Storage contract: type/app/time, type/app/severity, issue ID, session ID and replay ID. Its JSON payload remains authoritative and unchanged. Nullable scalar projections and a version marker are written in the same operation as the payload. BotFn intake and verified issue linking update projections inside their existing transaction; outbox identity, content fingerprints and deduplication are unchanged.

Exact string filters on `type`, `app.name`, `report.severity`, `integration.issueId`, `sessionId` and `replayId` can narrow database reads. Time ranges are resolved once by QueryEngine and finite epoch bounds narrow the same reads. Unsupported predicates, tags and metric-name matching remain authoritative postfilters; aggregation, ordering and limits are never applied prematurely to database candidates. Unknown/null projection versions use an unfiltered compatibility read, avoiding missing historical reports. Strings longer than 255 UTF-16 code units retain their complete JSON value and deliberately use version 0 scan fallback rather than truncation or index overflow. This is not arbitrary-query scalability: broad/matching sets still accumulate in memory, and tags do not have a dedicated index.

## Migration contract

The host owns DDL and backend durability. Stop all old/new writers, issue workers and queries during migration/backfill. Back up the database. Add every nullable field and index from `getWatchFnSchema()` before deploying the new writer. Do not set a default version of 1: only the complete projection writer/backfill may set it. Version 1 asserts every projection corresponds to the stored payload; arbitrary direct column/payload edits break that invariant. Existing data with null/unknown versions remains queryable while awaiting offline backfill, but retains the scan cost. New writes against a pre-migration table fail instead of acknowledging incomplete data. Backfill explicitly selects all projection columns before its first update, so missing columns fail before any backfill writes.

For the default table, the tested SQLite additive migration is:

```sql
ALTER TABLE watchfn_events ADD COLUMN projectionVersion INTEGER;
-- Also required by the subsequent canonical arrival-time retention writer:
ALTER TABLE watchfn_events ADD COLUMN receivedAt INTEGER;
ALTER TABLE watchfn_events ADD COLUMN eventType TEXT;
ALTER TABLE watchfn_events ADD COLUMN eventApp TEXT;
ALTER TABLE watchfn_events ADD COLUMN eventTimestamp REAL;
ALTER TABLE watchfn_events ADD COLUMN eventSeverity TEXT;
ALTER TABLE watchfn_events ADD COLUMN eventIssueId TEXT;
ALTER TABLE watchfn_events ADD COLUMN eventSessionId TEXT;
ALTER TABLE watchfn_events ADD COLUMN eventReplayId TEXT;
CREATE INDEX watchfn_events_type_app_time ON watchfn_events(eventType,eventApp,eventTimestamp);
CREATE INDEX watchfn_events_type_app_severity ON watchfn_events(eventType,eventApp,eventSeverity);
CREATE INDEX watchfn_events_issue ON watchfn_events(eventIssueId);
CREATE INDEX watchfn_events_session ON watchfn_events(eventSessionId);
CREATE INDEX watchfn_events_replay ON watchfn_events(eventReplayId);
CREATE INDEX watchfn_events_projection ON watchfn_events(projectionVersion,id);
```

Use the host's migration ledger to execute DDL once. Other dialects must use equivalent Unicode string columns and numeric epoch storage preserving JavaScript finite numeric timestamps (including fractions); do not use a 32-bit integer or lexical text for `eventTimestamp`. The schema declares string projection maximum lengths of 255. Custom table index names are bounded and deterministic; read them from the returned schema rather than constructing them. PostgreSQL/MySQL/Prisma/Drizzle physical migrations and query plans have not been validated here.

After DDL, run the internally schema-wrapped utility with a shared adapter (no caller `adapterSchema`):

```ts
import { DatabaseStorage } from "@watchfn/core";
const storage = new DatabaseStorage(database);
let after: string | undefined;
do {
  const page = await storage.backfillEventProjections({ after, limit: 100 });
  after = page.nextCursor ?? undefined;
} while (after !== undefined);
```

Each page is bounded to 1–1000 rows and resumes by storage ID, not producer report ID. Persist `nextCursor` only after a successful page. A page failure throws and may leave earlier rows in that page projected; rerunning the page or restarting from the beginning is idempotent. No payload or outbox fingerprint is rewritten. A full final page may return a cursor followed by an empty completion page. This is an offline live-keyset scan, not a retained database snapshot. Resume normal traffic only after reaching null. Existing compatibility adapters keep their own query/storage behavior and cannot use this migration utility.

## Validation

- All 179 core source tests pass; `tsc --noEmit` and CJS/ESM/declaration builds pass. Nine projection source tests cover projection precedence, unsupported-operator conservatism, resolved timezone bounds, aggregation/limit preservation, null/partial/unknown versions, more than 1000 matching rows, bounded backfill/error propagation, long strings and bounded custom index names.
- Native SQLite acceptance starts with the old two-column table and 1005 existing canonical JSON records. Missing-schema writes/backfill fail without extra rows. Additive DDL preserves existing records; authenticated loopback HTTP finds old matches before backfill and new/old matches afterward. Bounded backfill is idempotent and leaves payload bytes unchanged. Close/reopen preserves projections and results. SQLite EXPLAIN selects the type/app/time index.
- Native BotFn acceptance verifies canonical transactional intake/linking still works and linked issue-ID predicates find the resulting event. Local provider HTTP fixtures use actual BotFn clients; no external issues or messages are created.

Remaining original gates include retention defaults and bug-specific TTL, scalable broad queries/aggregations/tag filtering, operational migration scheduling, hosted database/provider acceptance, and deployment. The original Catch specification explicitly labels the Python canonical SDK as future work; the existing Python flat-report server is not canonical Watch transport parity and is not promoted into a v1 requirement by this change.

Reproduce from the repository root: `npm test --workspace @watchfn/core`, `npm exec --workspace @watchfn/core -- tsc --noEmit`, `npm run build --workspace @watchfn/core`, and `npm exec --workspace @watchfn/core -- vitest run --config tests/storage/event-indexes-sqlite.config.ts`. The native BotFn regression uses `tests/integrations/botfn-sqlite.config.ts`. Native tests require local Kysely and a working better-sqlite3 binding.

Canonical event retention and the bug TTL override are now implemented by the subsequent [arrival-time retention checkpoint](event-retention-readiness.md); its explicit policy, protected issue receipts and migration requirements apply. General non-app metric retention remains open.

The subsequent [query streaming checkpoint](query-streaming-readiness.md) removes
complete payload materialization for compatible scans and aggregates, with native
cross-page and constrained-heap evidence. Ordered/unlimited raw output, exact
sample/distinct/group cardinality, compatibility collation fallback and snapshot
semantics remain explicit scalability gates.
