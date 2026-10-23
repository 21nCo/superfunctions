# PHASE 02: Client `namespace` Config + Storage Factory

## Phase Goal

Add `namespace` config to the client, update `DatafnStorageFactory` signature, add `IndexedDbStorageAdapter.createForNamespace()`, update `switchContext`/`currentNamespace`, update cross-tab relay and changelog entry types.

## In Scope

- `DatafnClientConfig.namespace` field
- `DatafnStorageFactory` signature change (with legacy compat)
- `IndexedDbStorageAdapter.createForNamespace()`
- `SwitchContextOverride.namespace`
- `currentNamespace()` method on `DatafnClient`
- `DatafnChangelogEntry.actorId` field
- Cross-tab `BroadcastChannel` namespace scoping
- Client re-exports (`ns` from `@datafn/core`)
- Empty namespace validation on client
- SyncEngine namespace usage
- Client unit tests

## Out of Scope

- Server changes (done in Phase 1)
- CLI changes (Phase 3)
- Removing old `AuthContext` imports (kept for compat)

## Deliverables

| File | Action |
|---|---|
| `datafn/client/src/client.ts` | **Modify** — add `namespace` to config, `currentNamespace()`, update `switchContext`, namespace resolution logic |
| `datafn/client/src/storage.ts` | **Modify** — `DatafnStorageFactory` type, `DatafnChangelogEntry.actorId` |
| `datafn/client/src/adapters/indexedDbStorage.ts` | **Modify** — add `createForNamespace()` static method |
| `datafn/client/src/crossTab.ts` | **Modify** — use resolved namespace for channel name |
| `datafn/client/src/index.ts` | **Modify** — re-export `ns` from `@datafn/core` |
| `datafn/client/__tests__/namespace.test.ts` | **Create** — client namespace tests |
| `datafn/client/__tests__/indexeddb-namespace.test.ts` | **Create** — `createForNamespace` tests |

## Requirements Covered

NS-007, NS-008, NS-009, NS-010, NS-011, NS-012, NS-013, NS-014, NS-019, NS-020, NS-022, NS-023

## Implementation Tasks

1. Update `DatafnStorageFactory` type in `datafn/client/src/storage.ts`:
   ```typescript
   export type DatafnStorageFactory = (namespace: string) => DatafnStorageAdapter;
   ```
   Add note: when `authContext` is used (legacy), factory is called with `AuthContext` via runtime detection.

2. Add `actorId?: string` to `DatafnChangelogEntry` in `datafn/client/src/storage.ts`:
   - Keep `userId?: string` (deprecated)

3. Update `DatafnClientConfig` in `datafn/client/src/client.ts`:
   - Add `namespace?: string`
   - Keep `authContext` (deprecated)

4. Update `SwitchContextOverride` in `datafn/client/src/client.ts`:
   - Add `namespace?: string`
   - Keep `authContext` (deprecated)

5. Update client namespace resolution logic in `_buildRawClient()`:
   - Priority: `config.namespace` → derive from `config.authContext` → `undefined`
   - When `namespace` is provided and `storage` is factory: call factory with `namespace`
   - When `authContext` is provided and `storage` is factory: call factory with `AuthContext` (legacy)
   - When neither is provided and `storage` is factory: throw `DFQL_INVALID`
   - Empty `namespace` (`""`) validation: throw `DFQL_INVALID`
   - Store resolved namespace internally for use by cross-tab, sync, etc.

6. Add `currentNamespace()` to `DatafnClient` type and proxy:
   - Returns the resolved namespace string or `undefined`
   - Keep `currentContext()` (deprecated) — derive from legacy `authContext`

7. Update `switchContext` / `performSwitch`:
   - Accept `namespace` in overrides
   - When `namespace` is provided, use it for new client
   - When `authContext` is provided (legacy), derive namespace from it

8. Add `IndexedDbStorageAdapter.createForNamespace()`:
   ```typescript
   static createForNamespace(
     baseDbName: string,
     namespace: string,
     resources?: string[],
     schema?: DatafnSchema,
   ): IndexedDbStorageAdapter {
     const sanitized = namespace.replace(/:/g, '_');
     const dbName = `${baseDbName}_${sanitized}`;
     // ... same resource derivation logic as createForUser
   }
   ```
   - Deprecate `createForUser` (keep it working)

9. Update `CrossTabRelay` in `datafn/client/src/crossTab.ts`:
   - Constructor already receives namespace string — verify it uses the resolved namespace
   - Channel name format: `datafn:{namespace}`

10. Update `datafn/client/src/index.ts`:
    - Add `export { ns } from "@datafn/core"`
    - Keep existing `AuthContext`, `AuthContextProvider` re-exports

11. Update changelog entry stamping:
    - When writing entries, set `actorId` from resolved namespace provider (server side) or config (client side)
    - For client: `actorId` can be derived from namespace or set explicitly (TBD — for now, leave as optional)

12. Create `datafn/client/__tests__/namespace.test.ts`:
    - Test: client with `namespace` config → `currentNamespace()` returns it
    - Test: client with `authContext` (legacy) → `currentContext()` works
    - Test: `namespace` takes precedence over `authContext`
    - Test: factory called with `namespace` string
    - Test: factory without `namespace` throws `DFQL_INVALID`
    - Test: empty `namespace` throws `DFQL_INVALID`
    - Test: `switchContext({ namespace: "new" })` works
    - Test: `switchContext({ authContext: {...} })` legacy works

13. Create `datafn/client/__tests__/indexeddb-namespace.test.ts`:
    - Test: `createForNamespace("app", "org:user")` → db name `"app_org_user"`
    - Test: `createForNamespace("app", "user-1")` → db name `"app_user-1"`

## Verification Steps

```bash
# New tests
cd datafn && npx vitest run client/__tests__/namespace.test.ts
cd datafn && npx vitest run client/__tests__/indexeddb-namespace.test.ts

# Existing client tests (must not regress)
cd datafn && npx vitest run client/

# Type check
cd datafn && npx tsc --noEmit -p client/tsconfig.json
```

## Stop Condition

- All new client namespace tests pass.
- All existing client tests pass.
- `currentNamespace()` works.
- `switchContext({ namespace })` works.
- `createForNamespace()` works.
- `ns` is re-exported from `@datafn/client`.
- TypeScript compilation succeeds.
