# PHASE 03: CLI Codegen + Deprecation Warnings + Examples

## Phase Goal

Update CLI codegen to respect `namespaced`, add deprecation warnings for legacy APIs, and update the todo-app example to use the new API.

## In Scope

- CLI `generateDrizzleSchema()` update for `namespaced`
- Deprecation warnings in server, client, and schema validation
- Todo-app example migration to `namespaceProvider` / `namespace`
- Codegen tests

## Out of Scope

- New features beyond the namespace rename
- Other examples beyond todo-app

## Deliverables

| File | Action |
|---|---|
| `datafn/cli/src/drizzle-codegen.ts` | **Modify** — use `isNamespaced()` helper |
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | **Modify** — add tests for `namespaced` field |
| `datafn/server/src/server.ts` | **Modify** — add deprecation warning for `authContextProvider` at startup |
| `datafn/core/src/schema.ts` | **Modify** — add deprecation warning for `multiTenant` during validation |
| `datafn/client/src/client.ts` | **Modify** — add deprecation warning for `authContext` at creation |
| `datafn/examples/todo-app/server/src/index.ts` | **Modify** — migrate to `namespaceProvider` and `namespaced` |

## Requirements Covered

NS-016, NS-018

## Implementation Tasks

1. Update `datafn/cli/src/drizzle-codegen.ts`:
   - Replace `const isMultiTenant = schema.multiTenant !== false` with:
     ```typescript
     import { isNamespaced } from "@datafn/core";
     const isMultiTenant = isNamespaced(schema);
     ```
   - (Keep variable name `isMultiTenant` internally to minimize diff, or rename to `isNamespaced` — either is fine)

2. Update `datafn/cli/__tests__/drizzle-codegen.test.ts`:
   - Add test: schema with `namespaced: true` → `__ns` column emitted
   - Add test: schema with `namespaced: false` → no `__ns` column
   - Add test: schema with `multiTenant: true` (legacy) → still works

3. Add deprecation warning in `datafn/server/src/server.ts`:
   - After config validation, before `extractNamespace` setup:
     ```typescript
     if (config.authContextProvider && !config.namespaceProvider) {
       logger.warn("[datafn] authContextProvider is deprecated. Use namespaceProvider instead.", { operation: "deprecation" });
     }
     ```

4. Add deprecation warning in `datafn/core/src/schema.ts`:
   - During `validateSchema()`:
     ```typescript
     if (schema.multiTenant !== undefined && schema.namespaced === undefined) {
       console.warn("[datafn] multiTenant is deprecated. Use namespaced instead.");
     }
     ```
   - Fire at most once (module-level flag)

5. Add deprecation warning in `datafn/client/src/client.ts`:
   - During `_buildRawClient()`:
     ```typescript
     if (config.authContext && !config.namespace) {
       console.warn("[datafn] authContext is deprecated for namespace isolation. Use namespace instead.");
     }
     ```

6. Update `datafn/examples/todo-app/server/src/index.ts`:
   - Replace `multiTenant: true` with `namespaced: true` in schema
   - Replace `authContextProvider` with `namespaceProvider`:
     ```typescript
     namespaceProvider: {
       getNamespace: (_ctx: any) => ns("tenant-acme", "user-001"),
       getActorId: (_ctx: any) => "user-001",
     },
     ```
   - Import `ns` from `@datafn/core`

## Verification Steps

```bash
# CLI codegen tests
cd datafn && npx vitest run cli/__tests__/drizzle-codegen.test.ts

# Full CLI test suite
cd datafn && npx vitest run cli/

# Example builds
cd datafn/examples/todo-app/server && npx tsc --noEmit

# Full server test suite (deprecation warnings don't break tests)
cd datafn && npx vitest run server/

# Full client test suite
cd datafn && npx vitest run client/
```

## Stop Condition

- CLI codegen correctly uses `namespaced` with `multiTenant` fallback.
- Deprecation warnings are emitted for legacy API usage.
- Todo-app example compiles and uses new API.
- All tests pass.
