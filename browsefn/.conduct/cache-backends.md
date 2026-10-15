# BrowseFn persistent cache contract and acceptance

The cache now implements the existing memory, file, indexeddb and database configuration choices. Cache operations prune expired entries, preserve replacement-at-capacity, and evict least recently used entries. Exact TTL boundaries expire entries. Invalid TTL and capacity values are rejected. Stored/returned memory objects are detached from caller mutations.

## Configuration

TypeScript:

```ts
new CacheManager({ enabled: true, storage: 'file', directory: '/private/cache', name: 'retrieval', ttl: 60000, maxSize: 100 });
new CacheManager({ enabled: true, storage: 'indexeddb', name: 'retrieval' });
new CacheManager({ enabled: true, storage: 'database', database: sharedAdapter, name: 'retrieval' });
```

Python:

```python
CacheManager(CacheConfig(enabled=True, storage='file', directory='/private/cache', name='retrieval'))
CacheManager(CacheConfig(enabled=True, storage='database', database=shared_adapter, name='retrieval'))
```

- Default persistent identity is `browsefn`; default file directory is `.browsefn-cache` relative to process working directory. Select explicit directory/name in deployed applications. Cache names are hashed for file paths and compared exactly for IndexedDB/database isolation.
- TypeScript file storage uses `@superfunctions/storage-local` streams, a namespace lock, private temporary files, flush and atomic rename. Writers in different processes coordinate through the lock directory. A crashed process can leave its lock directory; operations time out after five seconds rather than stealing an uncertain lock. An operator may remove a stranded lock only after verifying no writer owns it. Local-filesystem behavior is intended; network-filesystem locking semantics have not been validated.
- Python file storage uses OS advisory locking, private temporary files, fsync and atomic replacement. POSIX behavior is tested; Windows locking is implemented but unvalidated. Both runtimes store separate file formats and do not claim cross-language cache-file interchange.
- IndexedDB TS uses one readwrite transaction for each operation and waits for transaction commit. `indexedDB` can optionally inject a factory for embedding/testing. Native browser IndexedDB is tested below; Node without a factory receives an actionable unavailable error.
- Ordinary CPython has no native browser IndexedDB. Its `indexeddb` choice requires an explicit `backend` bridge implementing async `transaction(name, callback)`. The callback receives the previous encoded string or None and returns `(new_encoded_string, result)`; the bridge must atomically commit the string and return `result`, aborting on callback failure. The supplied bridge contract is tested with a serialized test bridge; there is no bundled Pyodide/native bridge or claim of browser-Python runtime acceptance.
- Database storage uses the existing shared adapter, one named snapshot row and atomic numeric-revision conditional updates checked by affected-row count. Concurrent conflicts retry up to 32 times, then fail explicitly. Unique insertion protects first-writer races. TS wraps incoming adapters internally with its owned schema; applications do not pass adapterSchema. Primitive Python schema uses the shared database protocol; Python currently has no shared schema-wrapper primitive.
- Provision `browsefn_cache` with unique/primary `id`, non-null TEXT `value`, and non-null BIGINT `revision`. TS schema is `CacheManager.databaseSchema`; Python is `CacheManager.database_schema()`. SQL/ORM migrations remain application-owned. Names are SHA-256 hashed before entering database ids, and numeric revision predicates enforce conditional replacement regardless of text collation. TS row identities are prefixed `typescript:`, Python identities `python:`; encodings are intentionally distinct. Read/write/stat operations serialize a complete cache snapshot, appropriate for bounded local caches; this is not an indexed high-volume cache service.
- Persistence preserves bytes and supported BrowseFn result models (Python), Uint8Array/Date/bigint/undefined (TS), and nested primitive data. Functions and unknown Python model classes fail rather than serialize lossy values. Corrupt/unknown format fails explicitly and is not overwritten.
- Synchronous `has()` remains supported for memory. Persistent storage requires `await hasAsync()` / `await has_async()`; sync use throws an actionable error instead of reporting an unloaded persisted key absent. Other existing async operations retain their signatures. Statistics counts are manager-local; size reflects persisted, unexpired records.
- Python minimum metadata is corrected to >=3.10 because the already-required shared core distribution requires >=3.10. This is an explicit correction of an unsatisfiable >=3.9 installation claim, not proof of Python3.9 compatibility.

## Evidence

- TS focused tests: memory/file/IndexedDB/shared-memory-DB durability, isolation, rollback, invalidation, concurrent writes, TTL/capacity and value ownership. Added actual Drizzle/better-sqlite3 acceptance with no application adapterSchema, concurrent writes and bytes. Last focused persistence run: 17 passed; original cache-manager suite adds nine tests.
- Python cache tests: 12 passed, including actual SQLAlchemy/SQLite persistence and failed-write retention, file reopen/model/byte preservation, concurrent file managers, TTL/capacity and bridge contract. Shared-core Pydantic deprecation warnings remain outside this change.
- Full Python3.10 and Python3.12 suites passed 69 tests each. After final serialization changes, Python3.10 cache tests passed 12 tests again. Full release gate passes: TypeScript build/typecheck and 92 tests, Python3.12 69 tests, duplication 4.938383472272562% (545 lines, 46 clones), below the 5% threshold. Log: `/tmp/sf-browse-cache-final-gate.log`.
- Native Chrome 154.0.8037.58 passed `tests/cache-browser-acceptance.mjs`: 20 concurrent inserts, page-reload persistence, binary roundtrip, aborted-write retention and namespace clear isolation. Run with `PLAYWRIGHT_MODULE=/Volumes/Dev/n/superfunctions/node_modules/playwright CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node browsefn/typescript/tests/cache-browser-acceptance.mjs`. A disposable browser context is closed after execution.

Dependencies added: `@superfunctions/db@0.3.0`, `@superfunctions/storage-local@0.2.0`; test dependencies fake-indexeddb, better-sqlite3, Drizzle and better-sqlite3 types. Python test extra adds superfunctions-sqlalchemy 0.1.x. Shared storage builds and current TS typecheck pass. SQLite native bindings require install/build scripts (`npm rebuild better-sqlite3` was used after ignore-scripts installation).

These checks establish local backend behavior, not production readiness of all BrowseFn capabilities. Remaining backend validation: non-SQLite database dialect acceptance/collation and contention, multi-process crash recovery, Windows file semantics, and an actual Python IndexedDB bridge runtime if that configuration is required there.
