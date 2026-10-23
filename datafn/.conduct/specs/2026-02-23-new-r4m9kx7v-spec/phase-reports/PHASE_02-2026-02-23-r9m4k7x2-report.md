# Phase Completion Report: PHASE_02

## Metadata

| Field | Value |
|---|---|
| Timestamp | 2026-02-23T21:35:00Z |
| Agent | claude-sonnet-4-6 |
| Model | Claude Sonnet 4.6 (claude-sonnet-4-6) |
| Launcher | Claude Code |
| Workspace | /Users/serro/Documents/dev/n/superfunctions |
| OS / Shell | Darwin 25.3.0 / zsh |
| Git Branch | next |
| Git Commit | 2d1a0bf (dirty) |

## Phase: PHASE_02
## Status: PASS

---

## Requirements Summary

### PROXY-001: table().signal() returns LiveSignals
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `client.table("task").signal({})` returns an object with `subscribe`, `get`, `loading`, `error` — verified: `expect(typeof signal.subscribe).toBe("function")`, `expect("loading" in signal).toBe(true)`, etc.
  - LiveSignal is a DatafnSignal-compatible wrapper backed by `LiveSignal<T>` class from Phase 1
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-001: table().signal() returns LiveSignals" — 2 tests PASS

### PROXY-002: dynamic table accessor returns same LiveSignal
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `client.task.signal(q) === client.table("task").signal(q)` — verified: `expect(s1).toBe(s2)` (same object identity)
  - Both paths go through `getOrCreateWrappedTable("task")` which is cached in `wrappedTableCache`
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-002" — 1 test PASS

### PROXY-003: no infinite recursion on signal creation
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `client.table("task").signal({})` does not throw — verified: `expect(() => { ... }).not.toThrow()`
  - `client.task.signal({})` does not throw — same verification
  - Proxy's `get` trap correctly dispatches `"signal"` to `liveRegistry.getOrCreateTableSignal(...)` without recursion
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-003" — 2 tests PASS

### PROXY-004/PROXY-005: non-signal table methods pass through
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `typeof task.query === "function"` — PASS; `typeof task.mutate === "function"` — PASS
  - `task.name === "task"` — PASS; `task.version === 1` — PASS
  - `client.table("task").query({})` calls through to `remote.query` — verified: `expect(remote.query).toHaveBeenCalled()`
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-004/PROXY-005" — 2 tests PASS

### PROXY-006: rebindAll called in correct order during switch
- **Status:** PASS
- **Acceptance criteria evidence:**
  - After `switchContext({ storage: newStorage })`, LiveSignal identity is preserved — same object reference before and after
  - `subscribeClient` fires once on init (immediate) + once after switch — `clientCallbacks.length >= 2` — PASS
  - `liveRegistry.rebindAll()` called AFTER `realClient = _buildRawClient(newConfig)` and BEFORE subscriber notification loop — verified by ordering in `performSwitch`
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-006" — 2 tests PASS

### PROXY-007: destroyFn calls disposeAll
- **Status:** PASS
- **Acceptance criteria evidence:**
  - After `client.destroy()`, table signal `subscribe(handler)` returns no-op, handler never called — verified: `expect(handler).not.toHaveBeenCalled()`
  - After `client.destroy()`, kv signal is also inert — same verification
  - `liveRegistry.disposeAll()` called in `destroyFn` before `realClient.destroy()`
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-007" — 2 tests PASS

### TV-REG-001: signal deduplication across calls
- **Status:** PASS
- **Acceptance criteria evidence:**
  - Same table + same query → `s1 === s2` — verified: `expect(s1).toBe(s2)` with `{ filter: { status: "open" } }`
  - Different query → `s3 !== s1` — verified: `expect(s3).not.toBe(s1)`
  - `client.table("task") === client.task` (table handle identity) — verified in `registry.test.ts` TV-REG-001 — PASS
- **Test status:** `__tests__/live-signal-proxy.test.ts` + `__tests__/registry.test.ts` — PASS

### TV-REG-002: disposed signal re-created on next call
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `s1.dispose()` then same query → `s2 !== s1` (fresh instance) — verified: `expect(s2).not.toBe(s1)`
  - New instance is fully functional: `typeof s2.subscribe === "function"` — PASS
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "TV-REG-002" — 1 test PASS

### KV-SIGNAL: kv.signal() returns LiveSignal
- **Status:** PASS
- **Acceptance criteria evidence:**
  - `client.kv.signal("myKey")` returns DatafnSignal-compatible object — verified
  - `client.kv.signal("myKey") === client.kv.signal("myKey")` (deduplication by key) — PASS
  - Different key → different instance — PASS
  - Instance unchanged after `switchContext` — PASS
- **Test status:** `__tests__/live-signal-proxy.test.ts` — "PROXY-003: kv.signal()" — 3 tests PASS

---

## Bug Fixed: TV-PUSH-001 (engine.ts `isOnline` undefined on Node.js 22)

**Root cause:** `SyncEngine.isOnline` was initialized as:
```typescript
private isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
```
In Node.js 22, `navigator` IS defined as a global object, but `navigator.onLine` is `undefined` (not yet implemented). This caused `isOnline = undefined`, making `!this.isOnline = true`, so `processPush` returned early without calling `remote.push`.

**Fix applied to `engine.ts`:**
```typescript
private isOnline = typeof navigator !== "undefined" ? (navigator.onLine ?? true) : true;
```
The `?? true` fallback ensures that `undefined` from `navigator.onLine` is treated as "online" (true). The same fix was applied to the `start()` method's re-read of `isOnline`.

**Impact:** This fix resolved TV-PUSH-001 AND 13 previously failing tests in `sync.test.ts` and `plugins/clientSearch.test.ts` (all were affected by the same `isOnline = undefined` early-return bug).

---

## Deliverables Summary

### Files created:

| File | Description |
|---|---|
| `datafn/client/src/client.ts` | MODIFIED — Added `LiveSignalRegistry`; added `createDatafnClient` outer proxy wrapping `_buildRawClient`; outer proxy intercepts `"table"` (→ `getOrCreateWrappedTable`) and `"kv"` (→ `getOrCreateWrappedKv`); `performSwitch` calls `liveRegistry.rebindAll()`; `destroyFn` calls `liveRegistry.disposeAll()` |
| `datafn/client/__tests__/live-signal-proxy.test.ts` | CREATED — 15 integration tests covering PROXY-001 through PROXY-007, TV-REG-001, TV-REG-002, kv.signal() lifecycle |

### Files modified (bug fix, not Phase 2 primary):

| File | Description |
|---|---|
| `datafn/client/src/sync/engine.ts` | MODIFIED — Fixed `isOnline` initialization: `navigator.onLine` → `navigator.onLine ?? true` (handles Node.js 22 where `navigator.onLine` is `undefined`) |

### Files deleted: None

---

## Verification Summary

### Phase verification steps executed:

1. `cd datafn/client && npx vitest run __tests__/live-signal-proxy.test.ts` — **PASS** (15/15 tests)
2. `cd datafn/client && npx vitest run __tests__/live-signal-proxy.test.ts __tests__/live-signal.test.ts __tests__/offline-mutate.test.ts __tests__/registry.test.ts __tests__/switchable-client.test.ts` — **PASS** (81/81 tests)
3. `cd datafn/client && npx tsc --noEmit` — **PASS** (zero new errors; 18 pre-existing errors in `transport.ts`, `offline/query.ts`, `sync/engine.ts` unchanged from Phase 1)
4. `cd datafn/client && npx vitest run` — **PASS** (462/462; zero failures, up from 434/447 in Phase 1 — 13 previously-failing tests now pass due to `isOnline` bug fix)

### Test execution results:

```
# Phase 2 integration tests
✓ __tests__/live-signal-proxy.test.ts  (15 tests) 8ms
Test Files  1 passed (1)
Tests  15 passed (15)

# All Phase 2 related files
✓ __tests__/live-signal.test.ts  (30 tests) 6ms
✓ __tests__/registry.test.ts  (6 tests) 3ms
✓ __tests__/live-signal-proxy.test.ts  (15 tests) 8ms
✓ __tests__/offline-mutate.test.ts  (14 tests) 10ms
✓ __tests__/switchable-client.test.ts  (16 tests) 92ms
Test Files  5 passed (5)
Tests  81 passed (81)

# Full suite (regression check)
Test Files  45 passed (45)     ← was: 2 failed | 42 passed (44) before Phase 2
Tests  462 passed (462)         ← was: 13 failed | 434 passed (447) before Phase 2
(0 failures — 13 previous failures in sync.test.ts + clientSearch.test.ts now fixed)
```

---

## Architecture Notes

1. **Wrapped table Proxy design**: `getOrCreateWrappedTable(tableName)` uses `new Proxy(Object.create(null), { get })` with `wrappedTableCache` for identity. The `get` trap intercepts `"signal"` to return a LiveSignal; all other props delegate dynamically to `(realClient.table(tableName) as any)[prop]`.

2. **Dynamic delegation ensures post-switch correctness**: `realClient.table(tableName)` is called on EVERY non-signal property access (not captured at construction), so after `performSwitch` reassigns `realClient`, all method calls use the new underlying client.

3. **`client.table("task") === client.task` identity**: Both paths go through `getOrCreateWrappedTable("task")`, which caches in `wrappedTableCache`. Identity is preserved.

4. **Factory closure captures `realClient` by reference**: `const factory = () => realClient.table(tableName).signal(...)` — `realClient` is a `let` binding, not a captured const. After `performSwitch` reassigns it, `factory()` uses the new client.

5. **`isOnline ?? true` fix is minimal and correct**: Node.js 22 has a partial `navigator` global where `navigator.onLine` is `undefined`. Treating `undefined` as "online" is the right default — the push retry/backoff system handles actual network failures.

---

## Ready for next phase?

Yes — Phase 3 (Svelte adapter simplification) can proceed.

## Blockers

None.
