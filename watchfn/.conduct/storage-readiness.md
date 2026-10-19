# Shared database storage checkpoint — 2026-10-20

DatabaseStorage now accepts a shared `@superfunctions/db` Adapter and internally wraps it with WatchFn's own schema. `getWatchFnSchema()` exposes the default `watchfn_events` table: an internal unique string ID and required JSON-text payload. Applications own migrations and connection lifetime; they must not supply `adapterSchema`. The existing WatchFn database initialization selects this implementation without changes to callers. The `database` configuration now carries the shared-or-legacy TypeScript type.

Each arrival receives a new storage ID, independent of the producer's event ID. JSON is snapshotted before asynchronous writes. Full event metadata is retained, and database errors reject ingestion so HTTP cannot acknowledge a failed write. Reads use explicit 1,000-row pages to avoid default adapter truncation, then the existing QueryEngine applies canonical event filters, sorting, and limits. DatabaseStorage.query now applies its callback rather than ignoring it.

The former `insertEvent/queryEvents` adapter shape remains an explicitly deprecated compatibility bridge. It retains its queryOptions delegation and is not claimed to use shared schema codecs or provide durability.

## Validation

- Focused shared memoryAdapter storage and HTTP ingestion suites: 22 tests pass. Tests cover schema ownership without caller adapterSchema, metadata snapshots, producer-ID independence, more than 1,000 rows, canonical query filtering, propagated failures, and legacy compatibility. MemoryAdapter results are functional evidence only.
- Native SQLite acceptance: 1 test passes through shared Kysely adapter and better-sqlite3. HTTP ingestion writes a file-backed database; all connections close; a fresh connection reads the full Unicode/nested metadata. The physical payload column is JSON text. Dropping the table makes writes reject. Temporary files are removed in finally.
- Standalone WatchFn TypeScript checking passes.

Reproduce native acceptance from the repository root with `npm exec -w @watchfn/core -- vitest run --config tests/storage/sqlite.config.ts`. It requires installed Kysely/better-sqlite3 and a working native binding (`npm rebuild better-sqlite3 --foreground-scripts` after ignored install scripts). It runs separately from the normal unit suite so ordinary source validation does not silently depend on optional native drivers.

## Remaining original storage gates

This supplies the shared adapter integration required by SPEC, not the complete storage subsystem. Full-table retrieval is unbounded and not a scalable query strategy; offset paging is not a consistent snapshot under concurrent inserts/deletes. Indexed predicates, migrations/version upgrades, retention, tenancy/project isolation, hybrid tiers, transactions/atomic batches, producer deduplication, PostgreSQL/MySQL acceptance, crash recovery, performance targets, and Python parity remain open. JSON snapshots follow JSON semantics (Date becomes ISO, unsupported properties can disappear, cyclic values reject); rich Error/object normalization is still the collector's responsibility. The direct synchronous collector route still does not await persistence. No deployment, push, or PR occurred.
