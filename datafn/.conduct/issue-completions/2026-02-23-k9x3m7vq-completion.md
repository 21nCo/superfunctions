# Issue Completion Report

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T00:00:00Z |
| **Agent Name** | claude-sonnet-4-6 |
| **Model** | claude-sonnet-4-6 |
| **Launcher** | Claude Code (Zed) |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Workspace Path** | /Users/serro/Documents/dev/n |
| **Repo Metadata** | Not a git repository |

---

## Issue Summary

Two bugs in `@datafn/client` SyncEngine (`superfunctions/datafn/client/src/sync/engine.ts`):

1. **Bug 1** — SyncEngine only listened to `document.visibilitychange`, missing the `window.focus` event. Switching back to the browser window (Alt-Tab, clicking) without changing tab visibility never triggered a pull, causing stale data on multi-client setups.

2. **Bug 2** — `initializeWithHydrationPlan()` unconditionally called `cloneResources()` for all boot/background resources on every app load, even when IndexedDB already held fully hydrated (`"ready"`) data. This caused an unnecessary full `/clone` round-trip on every page reload.

---

## Status: PASS

---

## Requirements Checklist

### Bug 1: window.focus listener

| Requirement | Evidence |
|---|---|
| Add `boundOnWindowFocus` property | Added at line 50: `private boundOnWindowFocus: () => void;` |
| Bind in constructor | Added in constructor: `this.boundOnWindowFocus = this.onWindowFocus.bind(this);` |
| Register in `start()` with SSR guard | Added after visibilitychange block: `if (typeof window !== "undefined" && window.addEventListener) { window.addEventListener("focus", this.boundOnWindowFocus); }` |
| Unregister in `stop()` with SSR guard | Added after visibilitychange removal: `if (typeof window !== "undefined" && window.removeEventListener) { window.removeEventListener("focus", this.boundOnWindowFocus); }` |
| Implement `onWindowFocus()` handler | Added private method calling `this.pullNow()` |
| No duplicate pulls on rapid focus | `pullNow()` already has `if (this.pullInFlight) return;` guard |
| SSR-safe | Guarded with `typeof window !== "undefined"` |

### Bug 2: Clone on reload

| Requirement | Evidence |
|---|---|
| Check hydration state per boot resource | `initializeWithHydrationPlan()` now iterates boot resources calling `this.storage.getHydrationState(table)` |
| Only clone unready boot resources | `bootNeedingClone` array collects resources where `state !== "ready"`; only those are passed to `cloneResources()` |
| Pull when all boot resources already ready | `if (bootNeedingClone.length === 0 && bootResources.length > 0) { await this.pullNow(); }` |
| Same logic for background resources | `bgNeedingClone` array with identical check before `cloneResourcesInBackground()` |
| No unconditional clone | Old `if (bootResources.length > 0) { await this.cloneResources(bootResources); }` replaced with conditional |

---

## Implementation Details

**File changed:** `superfunctions/datafn/client/src/sync/engine.ts`

### Bug 1 changes (window.focus listener)

1. Added class property: `private boundOnWindowFocus: () => void;`
2. Bound in constructor: `this.boundOnWindowFocus = this.onWindowFocus.bind(this);`
3. Registered in `start()`:
   ```typescript
   if (typeof window !== "undefined" && window.addEventListener) {
     window.addEventListener("focus", this.boundOnWindowFocus);
   }
   ```
4. Unregistered in `stop()`:
   ```typescript
   if (typeof window !== "undefined" && window.removeEventListener) {
     window.removeEventListener("focus", this.boundOnWindowFocus);
   }
   ```
5. New private handler:
   ```typescript
   private onWindowFocus() {
     this.pullNow();
   }
   ```

### Bug 2 changes (initializeWithHydrationPlan)

Replaced the unconditional clone with per-resource hydration-state checks:

```typescript
private async initializeWithHydrationPlan() {
  const { bootResources = [], backgroundResources = [] } = this.hydrationPlan!;

  const bootNeedingClone: string[] = [];
  for (const table of bootResources) {
    const state = await this.storage.getHydrationState(table);
    if (state !== "ready") {
      bootNeedingClone.push(table);
    }
  }

  if (bootNeedingClone.length > 0) {
    await this.cloneResources(bootNeedingClone);
  }

  if (bootNeedingClone.length === 0 && bootResources.length > 0) {
    await this.pullNow();
  }

  const bgNeedingClone: string[] = [];
  for (const table of backgroundResources) {
    const state = await this.storage.getHydrationState(table);
    if (state !== "ready") {
      bgNeedingClone.push(table);
    }
  }

  if (bgNeedingClone.length > 0) {
    this.cloneResourcesInBackground(bgNeedingClone);
  }
}
```

---

## Verification

- Both fixes are isolated to `engine.ts` and do not change any public API or type signatures.
- The `window.focus` handler re-uses the existing `pullNow()` which has an in-flight deduplication guard (`if (this.pullInFlight) return;`), so rapid focus events are safe.
- The hydration-state check in `initializeWithHydrationPlan` mirrors the identical pattern already used in the default `initializeSync()` path (lines 279–292), ensuring consistent behavior across both code paths.
- No tests exist in this repository to run, but the logic matches the proposed fix exactly as specified in the issue.

---

## Files Changed

| File | Change |
|---|---|
| `superfunctions/datafn/client/src/sync/engine.ts` | Added `boundOnWindowFocus` property, constructor binding, `start()`/`stop()` registration, `onWindowFocus()` handler; refactored `initializeWithHydrationPlan()` to check hydration state before cloning |
| `superfunctions/datafn/.conduct/tracker.csv` | Marked `2026-02-23-k9x3m7vq-issue` as `status=1` with `completedAt` and `completionDoc` |
| `superfunctions/datafn/.conduct/logs.csv` | Appended execution log row |
