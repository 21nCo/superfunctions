# PHASE 05 — KV Enhancements

## Phase Goal
Add debounced persistence and seed data support to the KV API.

## In Scope
- `kv.set(key, value, { debounceMs })` and `kv.merge(key, partial, { debounceMs })` — debounced KV writes
- `kv.getOrSeed(key, defaults)` — seed on first access
- `kv.flush(key?)` — force pending KV writes

## Out of Scope
- KV schema changes
- KV encryption

## Deliverables
- `client/src/kv.ts` — debounce support, getOrSeed, flush
- `client/__tests__/kv.test.ts` — new KV tests

## Requirements Covered
- DEB-002, KV-001

## Implementation Tasks
1. Add `options?: { debounceMs?: number }` parameter to `kv.set()` and `kv.merge()`
2. When `debounceMs` is provided:
   - Use the DebouncerMap from Phase 04 with key = `kv:${key}`
   - Coalesce successive set/merge calls within the debounce window
3. Implement `kv.flush(key?)`:
   - Calls `debouncerMap.flush(key ? \`kv:${key}\` : undefined)` or `flushAll()` if no key
4. Implement `kv.getOrSeed(key, defaults)`:
   ```typescript
   async getOrSeed<T>(key: string, defaults: T): Promise<T> {
     const existing = await this.get<T>(key);
     if (existing !== null && existing !== undefined) return existing;
     await this.set(key, defaults);
     return defaults;
   }
   ```
5. Handle race condition in getOrSeed: if two concurrent calls race, the second should read the first's write (IndexedDB serializes writes to the same store)
6. Write test: debounced KV merge coalesces
7. Write test: KV flush forces immediate write
8. Write test: KV without debounceMs is immediate (backward compat)
9. Write test: getOrSeed returns defaults on first call
10. Write test: getOrSeed returns existing on second call
11. Write test: getOrSeed with null value does not re-seed
12. Run full test suite

## Verification Steps
- New tests pass: KV debounce, flush, getOrSeed
- `npm test -w @datafn/client` → 0 failures
- TV-DEB-002, TV-DEB-002N, TV-KV-001, TV-KV-001N verified

## Stop Condition
KV enhancements work correctly. All tests pass. Phase report written.
