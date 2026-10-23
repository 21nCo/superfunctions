# Phase goal

Expand the official browser client surface and implement the `account-settings` example app for API keys and 2FA.

## In scope / Out of scope

- In scope:
  - `@authfn/client` additive methods
  - optional `@authfn/svelte` helpers if needed by the example
  - account-settings example root/server/client
  - API key and 2FA Playwright coverage
- Out of scope:
  - multi-region routing

## Deliverables

- `authfn/client/src/index.ts`
- `authfn/client/src/types.ts`
- `authfn/client/src/http-client.ts`
- `authfn/client/src/__tests__/client-account-settings.test.ts`
- `authfn/examples/account-settings/README.md`
- `authfn/examples/account-settings/package.json`
- `authfn/examples/account-settings/playwright.config.ts`
- `authfn/examples/account-settings/e2e/account-settings.spec.ts`
- `authfn/examples/account-settings/server/package.json`
- `authfn/examples/account-settings/server/tsconfig.json`
- `authfn/examples/account-settings/server/superfunctions.config.ts`
- `authfn/examples/account-settings/server/drizzle.config.ts`
- `authfn/examples/account-settings/server/src/auth.ts`
- `authfn/examples/account-settings/server/src/db/client.ts`
- `authfn/examples/account-settings/server/src/db/generated/authfn-schema.ts`
- `authfn/examples/account-settings/server/src/index.ts`
- `authfn/examples/account-settings/client/package.json`
- `authfn/examples/account-settings/client/tsconfig.json`
- `authfn/examples/account-settings/client/vite.config.ts`
- `authfn/examples/account-settings/client/index.html`
- `authfn/examples/account-settings/client/src/main.ts`
- `authfn/examples/account-settings/client/src/App.svelte`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-003`
- `EXAUTH-008`
- `EXAUTH-010`
- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Add typed client methods for API keys, 2FA challenge/disable, social disconnect, runtime lookup, and region lookup.
2. Add unit tests covering successful and failing envelopes for the new client methods.
3. Create the account-settings example scaffold.
4. Implement the server with password, API key, and two-factor plugins.
5. Generate and import the CLI-created auth schema file.
6. Build the Svelte settings UI for 2FA enroll/confirm/challenge/disable and API key create/list/revoke.
7. Add Playwright coverage for invalid 2FA code and revoked-key failure cases.

## Verification steps

- Run `npm test --workspace @authfn/client -- account-settings`
  - Expected: client tests for new methods pass.
- Run `npm --prefix authfn/examples/account-settings/server run db:generate`
  - Expected: generated schema includes `api_keys` and `two_factor_*` tables.
- Run `npm --prefix authfn/examples/account-settings/server run db:push`
  - Expected: Postgres tables are created successfully.
- Run `npm --prefix authfn/examples/account-settings run test:e2e`
  - Expected: 2FA/API-key suite passes.

## Stop condition

Report the new public client methods and the example’s exercised routes before starting Phase 06.
