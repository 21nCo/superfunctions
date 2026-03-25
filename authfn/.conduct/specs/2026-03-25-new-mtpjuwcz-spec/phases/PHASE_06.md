# Phase goal

Implement the `multi-region-routing` example app across two local authorities with deterministic Playwright coverage.

## In scope / Out of scope

- In scope:
  - multi-region example root/server/client files
  - dual-authority local server startup
  - identifier lookup and wrong-authority correction
  - runtime inspection UI
- Out of scope:
  - new authfn core feature work beyond example wiring

## Deliverables

- `authfn/examples/multi-region-routing/README.md`
- `authfn/examples/multi-region-routing/package.json`
- `authfn/examples/multi-region-routing/playwright.config.ts`
- `authfn/examples/multi-region-routing/e2e/multi-region-routing.spec.ts`
- `authfn/examples/multi-region-routing/server/package.json`
- `authfn/examples/multi-region-routing/server/tsconfig.json`
- `authfn/examples/multi-region-routing/server/superfunctions.config.ts`
- `authfn/examples/multi-region-routing/server/drizzle.config.ts`
- `authfn/examples/multi-region-routing/server/src/auth.ts`
- `authfn/examples/multi-region-routing/server/src/db/client.ts`
- `authfn/examples/multi-region-routing/server/src/db/generated/authfn-schema.ts`
- `authfn/examples/multi-region-routing/server/src/index.ts`
- `authfn/examples/multi-region-routing/client/package.json`
- `authfn/examples/multi-region-routing/client/tsconfig.json`
- `authfn/examples/multi-region-routing/client/vite.config.ts`
- `authfn/examples/multi-region-routing/client/index.html`
- `authfn/examples/multi-region-routing/client/src/main.ts`
- `authfn/examples/multi-region-routing/client/src/App.svelte`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-003`
- `EXAUTH-009`
- `EXAUTH-010`
- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Create the multi-region example scaffold.
2. Implement two local authorities with fixed local base URLs and shared Postgres namespace.
3. Configure `authFnMultiRegionPlugin(...)` with deterministic region fixtures and authorities.
4. Generate and import the CLI-created auth schema file.
5. Build the Svelte UI for lookup, runtime inspection, and authority guidance.
6. Use the expanded browser client methods for `lookupRegion(...)` and `getRuntime()`.
7. Add Playwright coverage for lookup, wrong-authority rejection, and successful continuation on the correct authority.

## Verification steps

- Run `npm --prefix authfn/examples/multi-region-routing/server run db:generate`
  - Expected: generated schema includes `region_profiles`.
- Run `npm --prefix authfn/examples/multi-region-routing/server run db:push`
  - Expected: Postgres tables are created successfully.
- Run `npm --prefix authfn/examples/multi-region-routing run test:e2e`
  - Expected: dual-authority suite passes.

## Stop condition

Report the local authority URLs and the wrong-authority assertion behavior before starting Phase 07.
