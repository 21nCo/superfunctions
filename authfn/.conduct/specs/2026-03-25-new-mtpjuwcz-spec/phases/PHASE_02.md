# Phase goal

Implement the focused `password-sessions` example app with generated schema, manual run docs, and Playwright coverage.

## In scope / Out of scope

- In scope:
  - password example root/server/client files
  - generated-schema wiring
  - password/session UI
  - Playwright test
- Out of scope:
  - OTP features
  - OAuth features
  - API keys and 2FA

## Deliverables

- `authfn/examples/password-sessions/README.md`
- `authfn/examples/password-sessions/package.json`
- `authfn/examples/password-sessions/playwright.config.ts`
- `authfn/examples/password-sessions/e2e/password-sessions.spec.ts`
- `authfn/examples/password-sessions/server/package.json`
- `authfn/examples/password-sessions/server/tsconfig.json`
- `authfn/examples/password-sessions/server/superfunctions.config.ts`
- `authfn/examples/password-sessions/server/drizzle.config.ts`
- `authfn/examples/password-sessions/server/src/auth.ts`
- `authfn/examples/password-sessions/server/src/db/client.ts`
- `authfn/examples/password-sessions/server/src/db/generated/authfn-schema.ts`
- `authfn/examples/password-sessions/server/src/index.ts`
- `authfn/examples/password-sessions/client/package.json`
- `authfn/examples/password-sessions/client/tsconfig.json`
- `authfn/examples/password-sessions/client/vite.config.ts`
- `authfn/examples/password-sessions/client/index.html`
- `authfn/examples/password-sessions/client/src/main.ts`
- `authfn/examples/password-sessions/client/src/App.svelte`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-003`
- `EXAUTH-005`
- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Create the example root package with `dev:server`, `dev:client`, and `test:e2e`.
2. Implement the server with `authFnPasswordPlugin()` and shared demo routes.
3. Add `superfunctions.config.ts` and `drizzle.config.ts`.
4. Generate `src/db/generated/authfn-schema.ts` via CLI and wire it into the Drizzle client.
5. Build the Svelte client UI for sign-up, sign-in, current session, list sessions, revoke session, and sign-out.
6. Add stable `data-testid` selectors for all controls and state panels.
7. Write a Playwright suite that covers the full happy path and wrong-password failure.
8. Document install/run/db-generate/db-push/test commands in the README.

## Verification steps

- Run `npm --prefix authfn/examples/password-sessions/server run db:generate`
  - Expected: generated authfn schema file exists.
- Run `npm --prefix authfn/examples/password-sessions/server run db:push`
  - Expected: Postgres tables are created successfully.
- Run `npm --prefix authfn/examples/password-sessions run test:e2e`
  - Expected: password/session suite passes.

## Stop condition

Report the example URLs, scripts, and Playwright assertions before starting Phase 03.
