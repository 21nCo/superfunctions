# Issue Completion Report

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T17:10:00Z |
| **Agent Name** | unknown-agent |
| **Model** | claude-4.6-sonnet-medium-thinking |
| **Launcher** | Cursor |
| **Workspace Path** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Repo Metadata** | git branch: main (dirty) |
| **Issue File** | `datafn/.conduct/issues/2026-02-23-r4wp8n2j-issue.md` |

---

## Issue Summary

Every successful push unconditionally triggered a pull because the client's local cursor was never updated by push — only by clone/pull. The server returned a `cursor` in the push response that was always greater than the client's stored cursor, making `serverSeq > storedSeq` always `true`. This caused a redundant `pullNow()` after every push, even with a single client. A naive fix using `appliedCount` was insufficient because relation mutations consume multiple sequence numbers. The correct fix was to add `cursorBefore` to the push response — the global sequence before processing — so the client can cheaply determine if foreign changes exist.

---

## Status: PASS

---

## Requirements Summary

### Requirements Addressed

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Server: Add `cursorBefore` to `PushResult` interface | PASS | `PushResult.cursorBefore?: string` added in `push.ts` line 33 |
| 2 | Server: Capture `cursorBefore` before mutation loop | PASS | `const cursorBeforeSeq = await changeTracking.getCurrentServerSeq()` added before mutation loop |
| 3 | Server: Return `cursorBefore` in success response | PASS | `cursorBefore: String(cursorBeforeSeq)` in final return |
| 4 | Client: When `cursorBefore == localCursor` → advance cursor locally, skip pull | PASS | `TV-CURSOR-BEFORE-001` passes: pull not called, cursor advanced to "6" |
| 5 | Client: When `cursorBefore != localCursor` → pull to fetch foreign changes | PASS | `TV-CURSOR-BEFORE-002` passes: pull triggered when beforeSeq ≠ storedSeq |
| 6 | Client: Legacy fallback (no `cursorBefore`) → use old comparison | PASS | `TV-CURSOR-BEFORE-003` and `TV-CURSOR-BEFORE-004` pass |
| 7 | Use `setCursorMonotonically` for global cursor advance | PASS | `setCursorMonotonically` exported from `apply.ts` and imported/used in `engine.ts` |
| 8 | Backward compatible (no regression) | PASS | All 414 client tests + 21 server sync tests pass |

---

## Test Status

### New Tests Added

**Server (`datafn/server/__tests__/sync.test.ts`)** — 4 new tests, all pass:
- `TV-CURSOR-BEFORE-001`: Push returns cursorBefore = "0" for single client (fresh database)
- `TV-CURSOR-BEFORE-002`: cursorBefore reflects seq before push; second client sees first client's cursor
- `TV-CURSOR-BEFORE-003`: Relate mutation returns valid cursorBefore (< cursor, since 2+ seqs consumed)
- `TV-CURSOR-BEFORE-004`: Deduped push (idempotency hit) still returns cursorBefore

**Client (`datafn/client/__tests__/sync.test.ts`)** — 4 new tests, all pass:
- `TV-CURSOR-BEFORE-001`: cursorBefore == localCursor → no pull, cursor advanced locally to "6"
- `TV-CURSOR-BEFORE-002`: cursorBefore != localCursor → pull triggered
- `TV-CURSOR-BEFORE-003`: Legacy server (no cursorBefore), cursor > storedSeq → pull triggered (fallback)
- `TV-CURSOR-BEFORE-004`: Legacy server (no cursorBefore), cursor == storedSeq → no pull (fallback)

### Test Execution Results

```
Client: Test Files  42 passed (42) | Tests  414 passed (414)
Server sync: Test Files  1 passed (1) | Tests  21 passed (21)
```

Pre-existing server failures (unrelated): 16 failures in `dfql-aggregate`, `dfql-filter`, `dfql-pagination-count`, `dfql-select`, `dfql-transact`, `phase-08-envelopes-status-auth`, `query-execution` — these were failing before this change.

---

## Implementation Summary

### Files Changed

| File | Change |
|---|---|
| `datafn/server/src/execution/sync/push.ts` | Added `cursorBefore?: string` to `PushResult` interface; captured `cursorBeforeSeq` before mutation loop; included in success return value |
| `datafn/client/src/sync/apply.ts` | Exported `setCursorMonotonically` (changed `async function` to `export async function`) |
| `datafn/client/src/sync/engine.ts` | Imported `setCursorMonotonically`; replaced naive cursor comparison in `processPush()` with `cursorBefore`-aware logic |
| `datafn/server/__tests__/sync.test.ts` | Added 4 server-side tests for `cursorBefore` behavior |
| `datafn/client/__tests__/sync.test.ts` | Added 4 client-side tests for the new push cursor logic |

### Key Changes

**Server (`push.ts`):**
```typescript
// Before mutation loop:
const cursorBeforeSeq = await changeTracking.getCurrentServerSeq();

// In return:
return {
  ok: true, applied, errors,
  cursor: String(latestSeq),
  cursorBefore: String(cursorBeforeSeq),  // NEW
};
```

**Client (`engine.ts`) — `processPush()` cursor logic:**
```typescript
if (pushResult.cursorBefore !== undefined) {
  const beforeSeq = parseInt(pushResult.cursorBefore, 10);
  if (beforeSeq === storedSeq) {
    // No foreign changes — advance cursor locally, skip pull
    await setCursorMonotonically(this.storage, GLOBAL_CURSOR_KEY, pushResult.cursor);
  } else {
    // Foreign changes exist — pull to fetch them
    setTimeout(() => this.pullNow(), 0);
  }
} else {
  // Legacy fallback: old behavior
  const serverSeq = parseInt(pushResult.cursor, 10);
  if (serverSeq > storedSeq) {
    setTimeout(() => this.pullNow(), 0);
  }
}
```

---

## Verification Summary

### Commands Run

```bash
cd datafn/client && npx vitest run __tests__/sync.test.ts
# Result: 23/23 passed (includes 4 new TV-CURSOR-BEFORE tests)

cd datafn/client && npx vitest run
# Result: 414/414 passed (zero regressions)

cd datafn/server && npx vitest run __tests__/sync.test.ts
# Result: 21/21 passed (includes 4 new TV-CURSOR-BEFORE tests)
```

### Manual Verification

The logic was traced through the single-client scenario from the issue:
1. Clone → local cursor = `"5"`
2. User adds todo → optimistic write to IndexedDB + changelog append
3. `processPush()` → `POST /push` → server captures `cursorBefore = "5"`, allocates seq 6, returns `{ cursor: "6", cursorBefore: "5" }`
4. Client: `beforeSeq (5) === storedSeq (5)` → calls `setCursorMonotonically(storage, "__global_cursor__", "6")` → **no pull triggered**
5. Network traffic reduced from 2 requests (push + pull) to 1 request (push only)

---

## Notes

- `cursorBefore` is optional (`cursorBefore?: string`) in `PushResult` so early-exit error paths (invalid clientId, schema validation failures) do not need to capture it; the client handles the absent case via legacy fallback.
- Per the issue notes, per-table cursors are NOT advanced when skipping pull — only the global cursor is updated. Per-table cursors will be correctly updated on the next actual pull.
- The `getCurrentServerSeq()` method already existed on `ChangeTrackingService`, making the server change minimal (one additional call before the mutation loop).
- The implementation is backward compatible: servers that haven't been updated will not return `cursorBefore`, and the client falls back to the previous `serverSeq > storedSeq` comparison.
- Concurrent multi-client pushes are handled gracefully: if another client's seqs are allocated after our `cursorBefore` snapshot, those changes will be picked up at the next WebSocket notification or focus/visibility trigger (standard eventual consistency).
