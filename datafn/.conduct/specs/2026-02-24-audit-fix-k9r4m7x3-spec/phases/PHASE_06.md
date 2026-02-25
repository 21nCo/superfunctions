# PHASE 06: Data Retention (Pruning)

## Phase Goal

Implement configurable data retention policies for `__datafn_changes` and `__datafn_idempotency` tables, including pruning methods, configuration, startup pruning, and periodic background pruning.

## In Scope

- `ChangeTrackingService.pruneChanges(retentionDays)` method
- `DbIdempotencyStore.pruneIdempotency(retentionDays)` method
- `retention` config in `DatafnServerConfig`
- Startup pruning (`pruneOnStartup`)
- Periodic pruning (`pruneIntervalMs`)
- Interval cleanup on server close

## Out of Scope

- Pruning of other tables (`__datafn_meta`, `__datafn_seed`)
- External cron-based pruning integration
- Partition-based retention (table partitioning)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/sync/change-tracking.ts` | MODIFY — add `pruneChanges()` |
| `datafn/server/src/execution/idempotency-db.ts` | MODIFY — add `pruneIdempotency()` |
| `datafn/server/src/server.ts` | MODIFY — add retention config, startup prune, interval |
| `datafn/server/src/core-types.ts` | MODIFY — add `RetentionConfig` type |
| `datafn/server/__tests__/retention.test.ts` | CREATE — retention tests |

## Requirements Covered

- RET-001 (Change log pruning)
- RET-002 (Idempotency record pruning)
- RET-003 (Retention configuration)
- RET-004 (Auto-prune on startup)
- RET-005 (Periodic background pruning)

## Implementation Tasks

1. Add `pruneChanges()` to `ChangeTrackingService`:
   ```typescript
   async pruneChanges(retentionDays: number): Promise<number> {
     if (!this.changesEnsured) {
       await ensureInternalTable(this.db, "__datafn_changes");
       this.changesEnsured = true;
     }
     const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
     return await this.db.internal.delete("__datafn_changes", [
       { field: "namespace", op: "eq", value: this.namespace },
       { field: "created_at", op: "lt", value: cutoff },
     ]);
   }
   ```

2. Add `pruneIdempotency()` to `DbIdempotencyStore`:
   ```typescript
   async pruneIdempotency(retentionDays: number): Promise<number> {
     if (!this.ensured) {
       await ensureInternalTable(this.db, "__datafn_idempotency");
       this.ensured = true;
     }
     const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
     return await this.db.internal.delete("__datafn_idempotency", [
       { field: "namespace", op: "eq", value: this.namespace },
       { field: "created_at", op: "lt", value: cutoff },
     ]);
   }
   ```

3. Add `RetentionConfig` type:
   ```typescript
   export interface RetentionConfig {
     changeLogDays?: number;
     idempotencyDays?: number;
     pruneOnStartup?: boolean;
     pruneIntervalMs?: number;
   }
   ```

4. Wire retention into `createDatafnServer()`:
   - After `db.initialize()`:
     ```typescript
     if (config.retention?.pruneOnStartup && config.db) {
       try {
         const ct = new ChangeTrackingService(config.db, "datafn");
         if (config.retention.changeLogDays) {
           const deleted = await ct.pruneChanges(config.retention.changeLogDays);
           console.info(`Pruned ${deleted} change log entries`);
         }
         if (config.retention.idempotencyDays && idempotencyStore) {
           const deleted = await idempotencyStore.pruneIdempotency(config.retention.idempotencyDays);
           console.info(`Pruned ${deleted} idempotency entries`);
         }
       } catch (error) {
         console.warn("Startup pruning failed:", error);
       }
     }
     ```
   - For periodic pruning:
     ```typescript
     let pruneInterval: ReturnType<typeof setInterval> | null = null;
     if (config.retention?.pruneIntervalMs && config.db) {
       const intervalMs = Math.max(config.retention.pruneIntervalMs, 60000);
       pruneInterval = setInterval(async () => {
         try { /* same pruning logic */ } catch (e) { console.warn("Periodic prune failed:", e); }
       }, intervalMs);
     }
     ```
   - Return `close()` method on `DatafnServer`:
     ```typescript
     return { router, websocketHandler, close: () => { if (pruneInterval) clearInterval(pruneInterval); } };
     ```

5. Tests:
   - TV-RET-CHANGE-001: prune deletes old entries, keeps recent
   - TV-RET-CHANGE-002: prune respects namespace
   - TV-RET-IDEMP-001: idempotency prune
   - TV-RET-CONFIG-001: no retention config → no pruning
   - TV-RET-STARTUP-001: pruneOnStartup runs during init
   - TV-RET-INTERVAL-001: interval is created and clearable

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/retention.test.ts
npx vitest run
npx tsc --noEmit
```

**Expected**: All retention tests pass. Server still starts and operates correctly without retention config.

## Stop Condition

Report: Pruning methods implemented. Configuration wired. Startup and periodic pruning functional. Interval cleanup on close verified.
