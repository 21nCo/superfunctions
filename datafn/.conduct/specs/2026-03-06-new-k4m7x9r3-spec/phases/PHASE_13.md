# PHASE 13: Deprecate createSoftDeletePlugin

## Phase goal
Deprecate the existing `createSoftDeletePlugin` in favor of the `trash` capability.

## In scope
- Add deprecation console warning to `createSoftDeletePlugin`
- Add validation error when plugin is used alongside `trash` capability on same resource
- Update documentation references
- Keep plugin functional for backward compatibility

## Out of scope
- Removing the plugin entirely (future work)
- Data migration from isDeleted/deletedAt to trashedAt/trashedBy (user responsibility)

## Deliverables
- `datafn/client/src/plugins/softDelete.ts` (updated — deprecation warning + conflict check)
- `datafn/client/src/__tests__/plugins/softDelete-deprecation.test.ts` (new)

## Requirements covered
- CL-009

## Implementation tasks
1. In `createSoftDeletePlugin()`, add a `console.warn()` on construction:
   `"[datafn] createSoftDeletePlugin is deprecated. Use the 'trash' capability instead. See migration guide."`
2. In the plugin's `beforeMutation` hook, check if the resource has `trash` capability enabled:
   - If yes, throw error: `"Cannot use createSoftDeletePlugin on resource '${resource}' which has 'trash' capability enabled. Remove the plugin or the capability."`
3. Plugin continues to function as before (backward compatible)
4. Write tests:
   - Construction logs deprecation warning
   - Plugin on trash-enabled resource throws
   - Plugin on non-trash resource still works

## Verification steps
1. `cd datafn/client && npx vitest run` — all tests pass
2. `npx tsc --noEmit` — no type errors

## Stop condition
Plugin logs warning, conflicts detected, existing functionality preserved.
