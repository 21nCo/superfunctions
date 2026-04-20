# Phase goal

Make `@superfunctions/cli` capable of generating real `authfn` Drizzle schemas from example `createAuthFn(...)` source files.

## In scope / Out of scope

- In scope:
  - `@authfn/core` package discovery metadata
  - CLI function-call descriptor preservation
  - bundled plugin descriptor resolution for `getSchema(...)`
  - tests covering authfn CLI schema generation
- Out of scope:
  - example app UIs
  - Playwright suites
  - shared example harness

## Deliverables

- `authfn/core/package.json`
- `authfn/core/src/schema.ts`
- `authfn/core/src/index.ts`
- `authfn/core/src/types.ts`
- `authfn/core/src/schema-plugin-descriptors.ts`
- `authfn/core/tests/schema.test.ts`
- `packages/cli/src/utils/discover-packages.ts`
- `packages/cli/src/utils/parse-library-init.ts`
- `packages/cli/src/__tests__/authfn-schema-discovery.test.ts`
- `packages/cli/src/__tests__/parse-library-init.test.ts`

## Requirements covered

- `EXAUTH-003`
- `EXAUTH-004`

## Implementation tasks

1. Add `superfunctions` metadata to `@authfn/core/package.json` with `createAuthFn` discovery data.
2. Add a schema-only plugin descriptor resolver in `authfn/core` for all bundled authfn plugin factories.
3. Extend `getSchema(...)` to normalize live plugins and static descriptors into a single schema-resolution path.
4. Extend CLI parsing so function calls preserve callee name and serializable arguments.
5. Add tests proving descriptor-based authfn schema generation succeeds for password, OTP, social, API key, 2FA, and multi-region combinations.
6. Add a negative test proving unknown plugin descriptors fail with deterministic invalid-config behavior.

## Verification steps

- Run `npm test --workspace @authfn/core -- schema`
  - Expected: schema tests pass for live plugins and descriptor plugins.
- Run `npm test --workspace @superfunctions/cli -- authfn-schema-discovery parse-library-init`
  - Expected: CLI tests pass and preserved plugin-call args are asserted.
- In a temporary authfn-style fixture, run:

```bash
npx superfunctions generate-schema \
  --config ./superfunctions.config.ts \
  --library authfn \
  --adapter drizzle \
  --output ./generated \
  --force
```

  - Expected: `generated/authfn-schema.ts` is written and contains the expected authfn tables.

## Stop condition

Report the exact CLI/authfn files changed, the descriptor format chosen, and the verification output before starting Phase 01.
