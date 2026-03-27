# Phase goal

Implement the focused `otp-recovery` example app with deterministic inbox inspection and Playwright coverage.

## In scope / Out of scope

- In scope:
  - OTP example root/server/client files
  - verify-email flow
  - OTP sign-in flow
  - password reset flow
  - demo inbox wiring
- Out of scope:
  - OAuth features
  - API keys and 2FA

## Deliverables

- `authfn/examples/otp-recovery/README.md`
- `authfn/examples/otp-recovery/package.json`
- `authfn/examples/otp-recovery/playwright.config.ts`
- `authfn/examples/otp-recovery/e2e/otp-recovery.spec.ts`
- `authfn/examples/otp-recovery/server/package.json`
- `authfn/examples/otp-recovery/server/tsconfig.json`
- `authfn/examples/otp-recovery/server/superfunctions.config.ts`
- `authfn/examples/otp-recovery/server/drizzle.config.ts`
- `authfn/examples/otp-recovery/server/src/auth.ts`
- `authfn/examples/otp-recovery/server/src/db/client.ts`
- `authfn/examples/otp-recovery/server/src/db/generated/authfn-schema.ts`
- `authfn/examples/otp-recovery/server/src/index.ts`
- `authfn/examples/otp-recovery/client/package.json`
- `authfn/examples/otp-recovery/client/tsconfig.json`
- `authfn/examples/otp-recovery/client/vite.config.ts`
- `authfn/examples/otp-recovery/client/index.html`
- `authfn/examples/otp-recovery/client/src/main.ts`
- `authfn/examples/otp-recovery/client/src/App.svelte`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-003`
- `EXAUTH-006`
- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Create the OTP example root/server/client scaffold.
2. Implement the server with `authFnPasswordPlugin({ otp: ... })` plus `authFnEmailOtpPlugin(...)`.
3. Wire the shared OTP inbox capture to `GET /demo/otp/latest`.
4. Generate and import the CLI-created auth schema file.
5. Build the Svelte client flows for send, verify, sign-in by OTP, and password reset.
6. Add a Playwright suite that reads the deterministic inbox instead of relying on external delivery.
7. Document the purpose-specific OTP flows in the README.

## Verification steps

- Run `npm --prefix authfn/examples/otp-recovery/server run db:generate`
  - Expected: generated schema includes `otp_challenges`.
- Run `npm --prefix authfn/examples/otp-recovery/server run db:push`
  - Expected: Postgres tables are created successfully.
- Run `npm --prefix authfn/examples/otp-recovery run test:e2e`
  - Expected: OTP success and replay/invalid paths pass.

## Stop condition

Report the inbox contract and the Playwright scenarios before starting Phase 04.
