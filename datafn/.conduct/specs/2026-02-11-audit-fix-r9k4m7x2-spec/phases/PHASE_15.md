# PHASE 15 — Self-Healing Persistence and System Mutation Flag

## Phase Goal
Add storage health checking with recovery detection, and ensure system mutation flag propagates in events.

## In Scope
- `client.checkHealth()` — verify storage accessibility and hydration state
- `storage.healthCheck()` — verify IndexedDB is accessible and stores exist
- System mutation flag in event payload (already partially covered in Phase 06, this verifies integration)

## Out of Scope
- Auto-recovery (checkHealth only detects, does not auto-fix)
- Server-side health checks

## Deliverables
- `client/src/client.ts` — checkHealth() method
- `client/src/storage.ts` — healthCheck() interface
- `client/src/storage/indexedDbStorage.ts` — healthCheck() implementation
- `client/__tests__/health.test.ts` — health check tests

## Requirements Covered
- HEAL-001

## Implementation Tasks
1. Add `healthCheck(): Promise<{ ok: boolean; issues: string[] }>` to `DatafnStorageAdapter`
2. Implement in IndexedDB adapter:
   ```typescript
   async healthCheck() {
     const issues: string[] = [];
     try {
       // Verify database is open
       if (!this.db) issues.push("Database not initialized");
       // Verify expected object stores exist
       const storeNames = Array.from(this.db.objectStoreNames);
       for (const resource of this.expectedStores) {
         if (!storeNames.includes(resource)) {
           issues.push(`Missing object store: ${resource}`);
         }
       }
       // Verify cursor store is readable
       try { await this.getCursor("__health_check__"); } catch {
         issues.push("Cursor store is not readable");
       }
     } catch (err) {
       issues.push(`Storage access error: ${String(err)}`);
     }
     return { ok: issues.length === 0, issues };
   }
   ```
3. Implement `client.checkHealth()`:
   ```typescript
   async checkHealth(): Promise<DatafnHealthResult> {
     if (!this.storage) return { ok: true, issues: [], action: "none" };
     const storageHealth = await this.storage.healthCheck();
     const issues = [...storageHealth.issues];
     // Check hydration state consistency
     for (const resource of schema.resources) {
       if (resource.isRemoteOnly) continue;
       const state = await this.storage.getHydrationState(resource.name);
       if (state === "hydrating" && !this.syncEngine?.isCloning()) {
         issues.push(`Resource ${resource.name} stuck in hydrating state`);
       }
     }
     const action = issues.length > 0 ? "reclone" : "none";
     return { ok: issues.length === 0, issues, action };
   }
   ```
4. Write test: healthy storage returns ok
5. Write test: missing object store detected
6. Write test: stuck hydrating state detected
7. Write test: inaccessible storage detected
8. Run full test suite

## Verification Steps
- New tests pass: health check pass, health check fail scenarios
- `npm test -w @datafn/client` → 0 failures
- TV-HEAL-001, TV-HEAL-001N verified

## Stop Condition
Health check detects storage issues. All tests pass. Phase report written.
