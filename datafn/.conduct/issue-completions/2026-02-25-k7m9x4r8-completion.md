# Issue Completion Report: QuerySignal notifies subscribers before clearing inFlight flag — loading stuck at true

## Metadata

| Field | Value |
|-------|-------|
| **Issue ID** | 2026-02-25-k7m9x4r8-issue |
| **Completion Timestamp** | 2026-02-25T17:26:00Z |
| **Agent Name** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 (1M context) |
| **Launcher** | Claude Code (VSCode) |
| **Status** | Completed |

## Summary

Fixed the timing bug where `notifySubscribers()` was called while `inFlight` was still `true`, causing all query signals to permanently report `loading: true` and preventing data from rendering in the UI.

## Root Cause

In `fetchQuery()` within `querySignal.ts`, `notifySubscribers()` was called inside the `try` block at line 285, but `inFlight` was only cleared in the `finally` block at line 306. Since the `loading` getter returns `inFlight && !isRefresh`, every subscriber notification carried `loading: true` even when data had arrived. No second notification was emitted after `finally`, so consumers never saw `loading: false`.

## Changes Made

### File: `datafn/client/src/signals/querySignal.ts`

**Fix 1 — Success path (lines 283–286)**: Added `inFlight = false; isRefresh = false;` immediately before `notifySubscribers()` in the `try` block. This ensures subscribers read `loading: false` and `refreshing: false` at notification time.

**Fix 2 — Error path (lines 299–301)**: Added `inFlight = false; isRefresh = false;` before `notifySubscribers()` in the initial-load error branch, ensuring `loading: false` is also correct on error notifications.

The `finally` block retains `inFlight = false; isRefresh = false;` as a safety net (idempotent — already cleared in success/error paths).

### File: `datafn/client/__tests__/signals.test.ts`

Added 4 new tests:
1. **"loading transitions to false when data arrives"** — Verifies `signal.loading` is `false` at subscriber notification time
2. **"refreshing transitions to false after background re-fetch"** — Verifies `signal.refreshing` is `false` after refresh completes
3. **"loading is false at notification time even during error path"** — Verifies error notifications also have correct loading state
4. **"data and loading:false arrive in a single notification"** — Verifies data and `loading: false` are captured together in a single notification snapshot

### File: `datafn/svelte/__tests__/toSvelteStore.test.ts`

Added 1 new test:
1. **"TV-SVELTE-LOADING: store receives loading:false alongside data"** — Verifies the Svelte store wrapper receives correct loading state when signal notifies

## Testing Checklist

- [x] Verify `loading` transitions from `true` to `false` after initial fetch completes
- [x] Verify `refreshing` transitions correctly during background re-fetches
- [x] Verify `data` is emitted alongside `loading: false` in a single notification
- [x] Verify error path still sets `loading: false` (fetch failure)
- [x] Verify queued refresh still fires correctly after `finally`
- [x] Verify optimistic patches still work (merge mutations)
- [x] Verify Svelte store loading state reflects correctly

## Test Results

- `client/__tests__/signals.test.ts`: **24/24 passed** (including 4 new tests)
- `svelte/__tests__/toSvelteStore.test.ts`: **8/8 passed** (including 1 new test)
- `client/__tests__/live-signal.test.ts`: **30/30 passed** (no regressions)
