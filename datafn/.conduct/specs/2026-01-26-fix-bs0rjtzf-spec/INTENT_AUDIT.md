# Intent Audit — DataFn Client Typing + Sync/Remote Fix
Source of intent (PRIMARY): `datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md`

## Intent inventory (extracted)
1. `client.<table_name>` MUST be type-safe (no “Property does not exist on type DatafnClient” TypeScript error).
2. `client.table(tableName).query(...)` and `.signal(...)` MUST not accept arbitrary top-level keys; they MUST adhere to the DFQL shape at compile time.
3. The client MUST take care of remote querying and sync (batteries-included client-managed behavior).
4. The required “remote adapter” configuration is a drift; default usage MUST be URL-based (`sync.remote`) rather than user-supplied adapters.
5. Direct remote querying/mutation/transact MUST only be used when `offlinability` is false OR during initial hydration/clone when tables are not fully hydrated.
6. When `offlinability` is true, mutations MUST persist locally first and sync via `push`/`pull`.
7. Offlinability MUST NOT imply always offline; it means the data is present locally and writes are local-first (except remote-only tables).
8. `createDatafnClient` MUST support the expected config shape including `schema`, `storage`, `clientId`, and `sync` with `offlinability`, `remote`, `ws`, `pushInterval`, and room for additional sync config.
9. Push semantics:
   1) mutations written to a local mutations/changelog table first
   2) applied locally first unless remote-only
   3) pushed via `${remote}/push`
   4) retries handled by client
   5) repeated failures emit an event
   6) `pushInterval` batches; default is immediate push
   7) `pushBatchSize` default 100
   8) `pushMaxRetries` default 3
10. Pull semantics:
   - if `ws:true`, client uses WebSocket to pull changes (client establishes connection)
   - if `ws:false`, client uses HTTP pull:
     - on init: `clone` for fresh login/install; otherwise `pull`
     - on appear/visibility change
     - when push response returns cursor
   - pull uses `${remote}/pull`
   - pull has pagination+cursor; client manages pagination and cursor

## Coverage mapping
### 1) `client.<table_name>` typing
- Covered in SPEC.md: “Semantics → Type inference”
- Requirements: TYPES-001
- Test vectors: TV-TYPES-001 (positive), TV-TYPES-002 (negative)

### 2) DFQL shape typing for `query` and `signal`
- Covered in SPEC.md: “Public API → `@datafn/core`: DFQL structural types” and “Semantics → Type inference”
- Requirements: DFQL-001
- Test vectors: TV-DFQL-QUERY-001 (positive), TV-DFQL-QUERY-002 (negative), TV-DFQL-SIGNAL-001 (positive), TV-DFQL-SIGNAL-002 (negative)

### 3) Client owns remote querying + sync
- Covered in SPEC.md: “Overview”, “Semantics → Push loop”, “Semantics → Pull loop”
- Requirements: CFG-001, SYNC-MUT-001, SYNC-PULL-001..003
- Test vectors: TV-CFG-001 (positive), TV-PUSH-001 (positive), TV-PULL-001 (positive), TV-PULL-002 (positive)

### 4) Remove required remote adapter (default URL-based config)
- Covered in SPEC.md: “Expected configuration example” and “Public API → DatafnSyncConfig/DatafnClientConfig”
- Requirements: CFG-001
- Test vectors: TV-CFG-001 (positive), TV-CFG-002 (negative)

### 5) Remote usage only when offlinability false or during hydration
- Covered in SPEC.md:
  - “Semantics → Query routing”
  - “Semantics → Mutation routing”
  - “Semantics → Transact routing”
- Requirements: SYNC-QUERY-001, SYNC-MUT-001, SYNC-TX-001
- Test vectors: TV-ROUTE-QUERY-001 (positive), TV-ROUTE-QUERY-002 (negative), TV-TX-001 (positive), TV-TX-002 (negative)

### 6) Offlinability true: persist locally first, sync via push/pull
- Covered in SPEC.md: “Semantics → Mutation routing”, “Semantics → Push loop”, “Semantics → Pull loop”
- Requirements: SYNC-MUT-001, SYNC-PUSH-001, SYNC-PULL-003
- Test vectors: TV-PUSH-001 (positive), TV-MUT-001 (negative), TV-PULL-002 (positive), TV-PULL-003 (negative)

### 7) Offlinability meaning (not always offline; remote-only exception)
- Covered in SPEC.md: “Glossary”, “Invariants”, “Semantics → Query routing / Mutation routing”
- Requirements: SYNC-QUERY-001
- Test vectors: TV-ROUTE-QUERY-002 (negative)

### 8) Expected config shape
- Covered in SPEC.md: “Expected configuration example” and “Public API → `@datafn/client`: typed client factory + table registry”
- Requirements: CFG-001
- Test vectors: TV-CFG-001 (positive), TV-CFG-002 (negative)

### 9) Push semantics details
- Covered in SPEC.md: “Semantics → Push loop” and “Limits / caps”
- Requirements: SYNC-MUT-001, SYNC-PUSH-001, SYNC-PUSH-002
- Test vectors:
  - Ordering/local-first: TV-PUSH-001 (positive), TV-MUT-001 (negative)
  - Defaults: TV-PUSH-003 (positive), TV-PUSH-004 (negative)
  - Failure signaling: TV-PUSH-002 (positive), TV-PUSH-005 (negative)

### 10) Pull semantics details
- Covered in SPEC.md: “Semantics → Pull loop” and “WebSocket pull notifications”
- Requirements: SYNC-PULL-001, SYNC-PULL-002, SYNC-PULL-003, WS-001
- Test vectors:
  - Init clone decision: TV-PULL-001 (positive), TV-PULL-004 (negative)
  - Pagination/cursor: TV-PULL-002 (positive), TV-PULL-003 (negative)
  - Push cursor trigger: TV-PULL-005 (positive), TV-PULL-006 (negative)
  - WebSocket trigger: TV-WS-001 (positive), TV-WS-002 (negative)

## Result
No missing intent items.
