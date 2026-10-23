# PHASE 01: Server `namespaceProvider` + Legacy Bridge

## Phase Goal

Add `namespaceProvider` config to the server, refactor `extractNamespace` to use it, implement the backward-compat bridge for `authContextProvider`, update rate-limit key extraction, and add `actorId` extraction.

## In Scope

- `DatafnServerConfig.namespaceProvider` type and field
- `extractNamespace` refactor to use `namespaceProvider` → legacy bridge → default
- `actorId` extraction via `namespaceProvider.getActorId()`
- Rate-limit default key extractor update
- Empty namespace validation (`NAMESPACE_INVALID` error)
- Legacy bridge for `authContextProvider`
- Server tests

## Out of Scope

- Client changes
- CLI changes
- Deprecation warning logging (Phase 3)
- Removing `AuthContext` import (kept for legacy bridge)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/server.ts` | **Modify** — add `namespaceProvider` to config type, refactor `extractNamespace`, update rate-limit key extractor, add `extractActorId` |
| `datafn/server/src/core-types.ts` | **Modify** — if namespace provider types are defined here |
| `datafn/server/src/execution/sync/change-tracking.ts` | **Modify** — accept optional `actorId` parameter |
| `datafn/server/__tests__/namespace-provider.test.ts` | **Create** — tests for new provider |
| `datafn/server/__tests__/namespace-isolation.test.ts` | **Modify** — verify existing tests still pass with legacy bridge |

## Requirements Covered

NS-003, NS-004, NS-005, NS-006, NS-015, NS-021, NS-022

## Implementation Tasks

1. Add `namespaceProvider` to `DatafnServerConfig` type:
   ```typescript
   namespaceProvider?: {
     getNamespace: (ctx: TContext) => string | Promise<string>;
     getActorId?: (ctx: TContext) => string | Promise<string>;
   };
   ```
2. Refactor `extractNamespace` function:
   - If `namespaceProvider` is configured:
     - Call `getNamespace(ctx)`
     - Validate result is non-empty string
     - If empty: throw error with code `NAMESPACE_INVALID`
     - On error: propagate (no fallback)
   - Else if `authContextProvider` is configured (legacy bridge):
     - Call `getContext(ctx)`
     - Compose `tenant:${tenantId}:user:${userId}` or `user:${userId}`
     - Same behavior as current implementation
   - Else: return `"datafn"`
3. Add `extractActorId` internal function:
   - If `namespaceProvider.getActorId` exists: call it, return result
   - Else if `authContextProvider` exists: return `authContext.userId`
   - Else: return `undefined`
   - Errors: log warning, return `undefined` (non-fatal)
4. Update rate-limit default key extractor:
   - When `namespaceProvider` exists: use `getNamespace(ctx)` as key
   - When only `authContextProvider` exists: use `authContext.userId` (current behavior)
   - Fallback: `"anonymous"`
5. Update `shouldWrapNamespace` logic:
   - Use `isNamespaced(validatedSchema)` from `@datafn/core` instead of `validatedSchema.multiTenant !== false`
   - Check for `namespaceProvider` in addition to `authContextProvider`
6. Pass `extractActorId` to change tracking where changelog entries are created
7. Create `datafn/server/__tests__/namespace-provider.test.ts`:
   - Test: `namespaceProvider.getNamespace` returns custom string → used as namespace
   - Test: `namespaceProvider.getNamespace` returns empty → NAMESPACE_INVALID error
   - Test: `namespaceProvider.getNamespace` throws → error propagated
   - Test: both `namespaceProvider` and `authContextProvider` → `namespaceProvider` wins
   - Test: only `authContextProvider` → legacy bridge produces same format
   - Test: `getActorId` returns value → passed to change tracking
   - Test: `getActorId` throws → request succeeds, actorId is undefined
   - Test: rate limit key uses namespace
8. Verify existing `namespace-isolation.test.ts` tests pass unchanged

## Verification Steps

```bash
# New tests
cd datafn && npx vitest run server/__tests__/namespace-provider.test.ts

# Existing namespace tests (must not regress)
cd datafn && npx vitest run server/__tests__/namespace-isolation.test.ts

# Full server test suite
cd datafn && npx vitest run server/

# Type check
cd datafn && npx tsc --noEmit -p server/tsconfig.json
```

## Stop Condition

- New `namespaceProvider` tests pass.
- All existing server tests pass (especially namespace-isolation).
- Legacy `authContextProvider` behavior is byte-identical.
- TypeScript compilation succeeds.
