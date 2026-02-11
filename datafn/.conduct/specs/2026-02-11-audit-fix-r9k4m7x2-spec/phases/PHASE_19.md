# PHASE 19 — Audit Trail Enrichment and IDB Migration Hardening

## Phase Goal
Enrich changelog entries with audit context and improve IndexedDB migration reliability.

## In Scope
- Add `userId` and `timestamp` to changelog entries
- Two-phase IDB migration approach
- Migration error handling and recovery

## Out of Scope
- Retroactive enrichment of existing changelog entries
- Server-side audit log (separate concern)
- New IDB schema versions beyond current

## Deliverables
- `client/src/offline/mutate.ts` or `client/src/mutate.ts` — enriched changelog entries
- `client/src/storage/indexedDbStorage.ts` — improved migration handling
- `client/__tests__/changelog.test.ts` — audit trail tests
- `client/__tests__/idb-migration.test.ts` — migration tests

## Requirements Covered
- AUD-001, IDB-001

## Implementation Tasks
1. In changelog append path:
   - Add `userId` from client config's auth context (if available)
   - Add `timestamp: new Date().toISOString()`
   ```typescript
   const entry = {
     ...existingFields,
     userId: this.config.authContext?.userId ?? undefined,
     timestamp: new Date().toISOString(),
   };
   ```
2. Ensure push handler sends enriched entries (server ignores extra fields)
3. For IDB migration:
   - In `onupgradeneeded`, detect the old version
   - If migration requires async operations:
     a. Complete the synchronous schema changes in `onupgradeneeded`
     b. After database open, run async migration as a separate step
     c. Track migration status in a `__datafn_meta` store
   - If migration fails:
     a. Log the error
     b. Do NOT delete the old database
     c. Return health check issue via `healthCheck()`
4. Write test: changelog entry includes userId when auth context provided
5. Write test: changelog entry includes timestamp
6. Write test: changelog without auth context has undefined userId
7. Write test: push works with enriched entries
8. Write test: IDB v1→v2 migration preserves data
9. Write test: failed migration preserves original database
10. Run full test suite

## Verification Steps
- New tests pass: audit trail, IDB migration
- `npm test -w @datafn/client` → 0 failures
- TV-AUD-001/N, TV-IDB-001/N verified

## Stop Condition
Changelog is enriched. IDB migration is reliable. All tests pass. Phase report written.
