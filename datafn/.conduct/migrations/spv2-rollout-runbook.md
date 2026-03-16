# SPV2 Rollout Runbook (PHASE_10)

## Goal
Migrate from legacy per-resource permissions (`__datafn_permissions_<resource>`) to global SPV2 permissions (`__datafn_permissions_global`) without access drift.

## Migration flags
- `readMode`
  - `v1`: read only legacy tables (rollback mode)
  - `v2`: read only global table (target steady state)
  - `dual`: read both and use the stronger effective access decision
- `writeMode`
  - `v2`: write only global table
  - `dual`: write global + legacy (migration window)
- `warnOnLegacyApi`
  - `true`: log deterministic warning on `shareWith.userId` usage

## Rollout phases
1. Pre-check
- Confirm all shareable resources and namespaces to migrate.
- Snapshot `__datafn_permissions_global` and all legacy permission tables.

2. Compatibility window
- Deploy with `readMode=dual`, `writeMode=dual`, `warnOnLegacyApi=true`.
- Watch warning telemetry for legacy API usage.

3. Backfill
- Run backfill using `backfillLegacyPermissionsToSpv2` per namespace/resource set.
- Re-run backfill once to confirm idempotency (`migrated=0` on second run).

4. Cutover
- Switch to `readMode=v2`, keep `writeMode=dual` briefly.
- Validate equivalent allow/deny decisions on smoke scenarios.

5. Finalize
- Switch to `readMode=v2`, `writeMode=v2`.
- Keep warning telemetry enabled for compatibility period.

## Rollback
If access drift is detected after cutover:
1. Set `readMode=v1` immediately.
2. Optionally keep `writeMode=dual` while triaging.
3. Use CLI rollback SQL templates from `buildSpv2RollbackSql` if legacy tables require rehydration.
4. After fix, return to `readMode=dual`, validate, then recut to `v2`.

## Dry-run checklist
- Legacy share call (`table.share(id,userId,level)`) still succeeds.
- New principal call (`shareWith.principalId`) succeeds.
- Invalid legacy level still fails deterministically.
- Backfill conflict detection fails fast on duplicate conflicting levels.
