# Phase goal

Implement the core user/session kernel, cookie policy handling, and the base HTTP route surface.

# In scope / Out of scope

- In scope: users, sessions, cookie issuance/validation, current-session routes, session list/revoke routes
- Out of scope: password, OTP, social, API keys, 2FA, multi-region behavior

# Deliverables

- `authfn/core/src/core/users.ts`
- `authfn/core/src/core/sessions.ts`
- `authfn/core/src/core/cookies.ts`
- `authfn/core/src/core/errors.ts`
- `authfn/core/src/http/router.ts`
- `authfn/core/src/http/envelopes.ts`
- `authfn/core/src/__tests__/sessions.test.ts`
- `authfn/core/src/__tests__/cookies.test.ts`

# Requirements covered

- `CORE-001`
- `HTTP-001`
- `DATA-001`
- `SESS-001`

# Implementation tasks

1. Define abstract tables and indexes for `users` and `sessions`.
2. Implement session issue, read, list, revoke, and expiry logic.
3. Implement cookie issue/clear helpers using the shared HTTP dependency.
4. Add the base router and canonical success/error envelopes.
5. Wire `provider.authenticate()` to session and API-key dispatch placeholders.

# Verification steps

- Run `npm test --workspace @authfn/core -- sessions cookies`
- Send manual requests to `GET /auth/session`, `GET /auth/sessions`, `POST /auth/sign-out`
- Expected outcome: session cookies round-trip, revocation is immediate, CSRF behavior is enforced on unsafe routes.

# Stop condition

Report route list, cookie names/attributes, and the session-table/index layout.
