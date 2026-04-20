# Phase goal

Validate parser-agnostic consumption through commander, cac, and raw parseArgs canary fixtures.

# In scope / Out of scope

- In scope:
  - parser canary fixtures
  - integration-style tests
  - compatibility documentation snippets
- Out of scope:
  - migrating actual repository CLIs
  - introducing a clifn-owned parser DSL

# Deliverables

- Create `clifn/core/tests/fixtures/commander/*`
- Create `clifn/core/tests/fixtures/cac/*`
- Create `clifn/core/tests/fixtures/parse-args/*`
- Create `clifn/core/tests/parser-canaries.test.ts`
- Modify `clifn/core/README.md`

# Requirements covered

- `PARS-001`
- `RUN-001`
- `OUT-001`

# Implementation tasks

- Build one minimal `commander` fixture that uses the runner and output service.
- Build one minimal `cac` fixture that uses the runner and output service.
- Build one minimal `parseArgs` fixture that uses the runner and output service.
- Ensure the fixtures do not require `clifn` itself to add parser-specific runtime dependencies.
- Add tests proving the generic APIs are consumed successfully in all three styles.

# Verification steps

- Run `npm run test -- --filter=clifn -- parser-canaries`
- Expected outcomes:
  - commander canary passes
  - cac canary passes
  - parseArgs canary passes
  - clifn core remains parser-agnostic

# Stop condition

Stop after parser-agnostic compatibility is demonstrated with concrete fixtures.

