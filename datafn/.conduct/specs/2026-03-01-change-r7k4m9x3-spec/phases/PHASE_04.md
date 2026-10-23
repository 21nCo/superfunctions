# PHASE 04: Integration Verification + Cleanup

## Phase Goal

Run the full test suite across all packages to verify no regressions. Fix any remaining issues. Ensure end-to-end integration works with the new namespace model.

## In Scope

- Full test suite execution (core, server, client, cli)
- Fix any test failures caused by the refactor
- Verify TypeScript compilation across all packages
- Verify the example app runs correctly
- Clean up any dead imports (e.g. unused `AuthContext` imports in server after bridge is in place)

## Out of Scope

- Removing deprecated APIs (future major version)
- New features
- Database migrations

## Deliverables

| File | Action |
|---|---|
| Various test files | **Modify** — fix any failures |
| Various source files | **Modify** — clean up dead imports if any |

## Requirements Covered

All NS-* requirements verified end-to-end.

## Implementation Tasks

1. Run full core test suite:
   ```bash
   cd datafn && npx vitest run core/
   ```
   Fix any failures.

2. Run full server test suite:
   ```bash
   cd datafn && npx vitest run server/
   ```
   Fix any failures. Pay special attention to:
   - `namespace-isolation.test.ts` — must produce identical namespaces via legacy bridge
   - `sync.test.ts` — change tracking namespace scoping
   - `ws.test.ts` — WS namespace scoping
   - `authz.test.ts` — authorization still works
   - `rate-limit.test.ts` — key extraction

3. Run full client test suite:
   ```bash
   cd datafn && npx vitest run client/
   ```
   Fix any failures. Pay special attention to:
   - `crossTab.test.ts` — channel naming
   - `bus.test.ts` — event scoping
   - `cloneUp.test.ts` — sync namespace

4. Run full CLI test suite:
   ```bash
   cd datafn && npx vitest run cli/
   ```

5. TypeScript compilation across all packages:
   ```bash
   cd datafn && npx tsc --noEmit -p core/tsconfig.json
   cd datafn && npx tsc --noEmit -p server/tsconfig.json
   cd datafn && npx tsc --noEmit -p client/tsconfig.json
   cd datafn && npx tsc --noEmit -p cli/tsconfig.json
   ```

6. Verify example app:
   ```bash
   cd datafn/examples/todo-app/server && npx tsc --noEmit
   ```

7. Clean up:
   - Remove any unused imports introduced by the refactor
   - Ensure no `TODO` comments were left in source code
   - Verify package.json dependencies are correct (no new deps needed)

## Verification Steps

```bash
# Full test suite
cd datafn && npx vitest run

# All TypeScript compilation
cd datafn && npx tsc --noEmit -p core/tsconfig.json && \
  npx tsc --noEmit -p server/tsconfig.json && \
  npx tsc --noEmit -p client/tsconfig.json && \
  npx tsc --noEmit -p cli/tsconfig.json
```

## Stop Condition

- All tests pass across all packages.
- TypeScript compilation succeeds across all packages.
- Example app compiles.
- No `TODO` comments left from this refactor.
- All 23 requirements (NS-001 through NS-023) verified.
