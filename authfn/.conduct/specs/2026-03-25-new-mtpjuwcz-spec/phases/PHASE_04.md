# Phase goal

Implement the focused `social-oauth` example app using a local fake OAuth provider and Playwright coverage.

## In scope / Out of scope

- In scope:
  - social example root/server/client files
  - fake provider routes
  - start/callback/disconnect flow
  - disallowed redirect error path
- Out of scope:
  - API keys and 2FA
  - multi-region routing

## Deliverables

- `authfn/examples/social-oauth/README.md`
- `authfn/examples/social-oauth/package.json`
- `authfn/examples/social-oauth/playwright.config.ts`
- `authfn/examples/social-oauth/e2e/social-oauth.spec.ts`
- `authfn/examples/social-oauth/server/package.json`
- `authfn/examples/social-oauth/server/tsconfig.json`
- `authfn/examples/social-oauth/server/superfunctions.config.ts`
- `authfn/examples/social-oauth/server/drizzle.config.ts`
- `authfn/examples/social-oauth/server/src/auth.ts`
- `authfn/examples/social-oauth/server/src/db/client.ts`
- `authfn/examples/social-oauth/server/src/db/generated/authfn-schema.ts`
- `authfn/examples/social-oauth/server/src/index.ts`
- `authfn/examples/social-oauth/client/package.json`
- `authfn/examples/social-oauth/client/tsconfig.json`
- `authfn/examples/social-oauth/client/vite.config.ts`
- `authfn/examples/social-oauth/client/index.html`
- `authfn/examples/social-oauth/client/src/main.ts`
- `authfn/examples/social-oauth/client/src/App.svelte`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-003`
- `EXAUTH-007`
- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Create the social example scaffold.
2. Implement local fake-provider endpoints using the shared harness.
3. Configure `authFnSocialOAuthPlugin(...)` against the local provider URLs and allowlisted return targets.
4. Generate and import the CLI-created auth schema file.
5. Build the Svelte UI for provider start, callback completion state, and disconnect.
6. Add Playwright coverage for at least one full success flow and one redirect-disallowed failure.
7. Document clearly that no live provider credentials are required.

## Verification steps

- Run `npm --prefix authfn/examples/social-oauth/server run db:generate`
  - Expected: generated schema includes OAuth storage and `oauth_accounts`.
- Run `npm --prefix authfn/examples/social-oauth/server run db:push`
  - Expected: Postgres tables are created successfully.
- Run `npm --prefix authfn/examples/social-oauth run test:e2e`
  - Expected: fake-provider browser flow and disconnect pass.

## Stop condition

Report the fake-provider routes, allowed return targets, and Playwright flow before starting Phase 05.
