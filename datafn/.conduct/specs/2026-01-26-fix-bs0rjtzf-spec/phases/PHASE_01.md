# PHASE_01
## Phase goal
Implement schema-driven TypeScript typing for `client.<tableName>`, `client.table(name)`, and DFQL query/signal fragments.

## In scope
- Make `createDatafnClient` generic over schema and return `DatafnClient<S>`.
- Implement `DatafnClient<S>` mapped property typing for schema resource names.
- Update `DatafnTable.query`/`signal` to accept `DfqlQueryFragment`.
- Add type-level verification (via `tsc` typecheck and/or `expectTypeOf`) to prevent regressions.

## Out of scope
- Runtime behavior changes to the Proxy table registry (this phase is type-level only).

## Deliverables
- Modify: `datafn/client/src/client.ts`
- Modify: `datafn/client/src/tables/registry.ts`
- Modify: `datafn/client/src/tables/table.ts`
- Add tests: `datafn/client/__tests__/types.test.ts` (or equivalent)

## Requirements covered
- TYPES-001
- TYPES-002
- DFQL-001

## Implementation tasks
1. Define `ResourceNames<S>` and `DatafnClient<S>` mapped type in `@datafn/client` and apply it to `createDatafnClient` return type.
2. Update `client.table(name)` signature to narrow `name` to schema resource names.
3. Update `DatafnTable.query` and `DatafnTable.signal` to accept `DfqlQueryFragment`.
4. Add a type-focused test that:
   - asserts `client.task` is a `DatafnTable`
   - asserts `client.table("task")` is allowed
   - asserts unknown table property access and extra DFQL fragment keys fail compilation (as close as feasible with current test tooling)

## Verification steps
- `npm --prefix datafn/client test`
- `npm --prefix datafn/client test:watch` (optional)
- `npm --prefix datafn/client build`

Expected outcomes:
- Tests pass.
- Build passes.

## Stop condition
Report the updated exported typings and show that the new type regression coverage is in place before starting PHASE_02.
