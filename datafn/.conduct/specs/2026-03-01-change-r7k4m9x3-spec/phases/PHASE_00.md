# PHASE 00: Core Types + `ns()` Helper

## Phase Goal

Add the `ns()` composable namespace helper to `@datafn/core` and update `DatafnSchema` type to accept `namespaced` alongside deprecated `multiTenant`.

## In Scope

- `ns()` function implementation and export
- `DatafnSchema` type update (`namespaced?: boolean`)
- `defineSchema()` generic constraint update
- Schema validation logic to handle both `namespaced` and `multiTenant`
- Unit tests for `ns()`
- Type compilation verification

## Out of Scope

- Server changes
- Client changes
- CLI changes
- Deprecation warning emission (deferred to Phase 3)

## Deliverables

| File | Action |
|---|---|
| `datafn/core/src/ns.ts` | **Create** — `ns()` function |
| `datafn/core/src/index.ts` | **Modify** — export `ns` |
| `datafn/core/src/types.ts` | **Modify** — add `namespaced` to `DatafnSchema`, update `defineSchema()` |
| `datafn/core/src/schema.ts` | **Modify** — validation logic handles `namespaced` with `multiTenant` fallback |
| `datafn/core/__tests__/ns.test.ts` | **Create** — unit tests for `ns()` |
| `datafn/core/__tests__/schema.test.ts` | **Modify** — add tests for `namespaced` field |

## Requirements Covered

NS-001, NS-002, NS-017

## Implementation Tasks

1. Create `datafn/core/src/ns.ts`:
   - Export `function ns(...segments: string[]): string`
   - Filter falsy/empty segments
   - Join with `:`
   - Throw if result is empty
2. Update `datafn/core/src/index.ts`:
   - Add `export { ns } from "./ns.js"`
3. Update `DatafnSchema` type in `datafn/core/src/types.ts`:
   - Add `namespaced?: boolean` field
   - Keep `multiTenant?: boolean` (deprecated)
4. Update `defineSchema()` generic constraint in `datafn/core/src/types.ts`:
   - Add `readonly namespaced?: boolean` to the constraint
5. Update schema validation in `datafn/core/src/schema.ts`:
   - When resolving whether namespace isolation is enabled: check `namespaced` first, fall back to `multiTenant`, default `true`
   - Add helper: `isNamespaced(schema: DatafnSchema): boolean` → `schema.namespaced ?? schema.multiTenant ?? true`
   - Export `isNamespaced` for use by server, client, CLI
6. Create `datafn/core/__tests__/ns.test.ts`:
   - Test: two segments → `"a:b"`
   - Test: single segment → `"a"`
   - Test: three segments → `"a:b:c"`
   - Test: empty segments filtered → `ns("a", "", "b")` → `"a:b"`
   - Test: all empty throws
   - Test: `ns()` with no args throws
7. Update `datafn/core/__tests__/schema.test.ts`:
   - Test: schema with `namespaced: true` validates
   - Test: schema with `namespaced: false` validates
   - Test: schema with both `namespaced` and `multiTenant` — `namespaced` wins
   - Test: schema with only `multiTenant` — still works
   - Test: `isNamespaced()` helper

## Verification Steps

```bash
# Unit tests
cd datafn && npx vitest run core/__tests__/ns.test.ts
cd datafn && npx vitest run core/__tests__/schema.test.ts

# Type check
cd datafn && npx tsc --noEmit -p core/tsconfig.json

# Existing tests still pass
cd datafn && npx vitest run core/
```

## Stop Condition

- All `ns()` tests pass.
- Schema tests pass with `namespaced` field.
- `isNamespaced()` helper exported and tested.
- TypeScript compilation succeeds.
- No existing core tests broken.
