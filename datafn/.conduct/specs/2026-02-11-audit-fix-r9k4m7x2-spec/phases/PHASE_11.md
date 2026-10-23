# PHASE 11 — Offline Improvements (Batch Fallback + Atomic Merge + Deep Merge)

## Phase Goal
Improve offline mutation quality: enable batch offline fallback, atomic merge operations, and one-level-deep merge for nested objects.

## In Scope
- Batch offline fallback (iterate handleOfflineMutation per item)
- `mergeRecord()` on storage adapter (atomic read-modify-write)
- One-level-deep merge for object-type fields in offline merge
- IndexedDB implementation of mergeRecord using readwrite transaction

## Out of Scope
- Multi-level deep merge (only one level)
- Array merging
- Conflict resolution beyond LWW

## Deliverables
- `client/src/storage.ts` — mergeRecord interface
- `client/src/storage/indexedDbStorage.ts` — atomic mergeRecord implementation
- `client/src/offline/mutate.ts` — use mergeRecord, deep merge logic
- `client/src/mutate.ts` — batch offline fallback
- `client/__tests__/offline.test.ts` — new tests

## Requirements Covered
- OFF-001, OFF-002, OFF-003

## Implementation Tasks
1. Add `mergeRecord(resource: string, id: string, partial: Record<string, unknown>): Promise<Record<string, unknown>>` to `DatafnStorageAdapter`
2. Implement in IndexedDB adapter:
   ```typescript
   async mergeRecord(resource, id, partial) {
     const tx = this.db.transaction(resource, "readwrite");
     const store = tx.objectStore(resource);
     const existing = await store.get(id);
     const merged = deepMergeOneLevel(existing ?? { id }, partial);
     await store.put(merged);
     await tx.done;
     return merged;
   }
   ```
3. Implement `deepMergeOneLevel(target, source)`:
   ```typescript
   function deepMergeOneLevel(target, source) {
     const result = { ...target };
     for (const key of Object.keys(source)) {
       const sv = source[key];
       const tv = target[key];
       if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
           tv !== null && typeof tv === "object" && !Array.isArray(tv)) {
         result[key] = { ...tv, ...sv }; // one-level deep merge
       } else {
         result[key] = sv; // overwrite
       }
     }
     return result;
   }
   ```
4. In `handleOfflineMutation()` for merge operations:
   - Replace `getRecord + { ...existing, ...record } + upsertRecord` with `mergeRecord(resource, id, record)`
5. In batch mutation fallback (mutate.ts):
   - When batch fails with transport error and `storage` exists:
   ```typescript
   if (Array.isArray(m) && storage && isTransportError(err)) {
     const results = [];
     for (const mutation of m) {
       try {
         const result = await handleOfflineMutation(storage, schema, mutation);
         emitMutationEvents(eventBus, mutation, result); // unless silent
         results.push({ ok: true, ...result });
       } catch (mutErr) {
         results.push({ ok: false, error: mutErr });
       }
     }
     return aggregateBatchResults(results);
   }
   ```
6. Write test: batch offline fallback applies all mutations locally
7. Write test: mergeRecord is atomic (read + merge + write in one transaction)
8. Write test: mergeRecord upserts if record missing
9. Write test: deep merge preserves sibling keys in nested objects
10. Write test: deep merge overwrites arrays (no array merge)
11. Write test: deep merge at most one level (second-level objects overwrite)
12. Run full test suite

## Verification Steps
- New tests pass: batch fallback, atomic merge, deep merge
- `npm test -w @datafn/client` → 0 failures
- TV-OFF-001/N, TV-OFF-002/N, TV-OFF-003/N verified

## Stop Condition
All three offline improvements work correctly. All tests pass. Phase report written.
