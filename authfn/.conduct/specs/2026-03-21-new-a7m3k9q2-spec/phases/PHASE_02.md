# Phase goal

Add the email-password plugin and the browser client core.

# In scope / Out of scope

- In scope: password credential schema, sign-up, sign-in, client methods for session/password flows
- Out of scope: OTP, social, API keys, 2FA, multi-region routing

# Deliverables

- `authfn/core/src/plugins/email-password.ts`
- `authfn/core/src/core/passwords.ts`
- `authfn/core/src/__tests__/password.test.ts`
- `authfn/client/src/http-client.ts`
- `authfn/client/src/types.ts`
- `authfn/client/src/index.ts`
- `authfn/client/src/__tests__/client-password.test.ts`

# Requirements covered

- `PASS-001`
- `CLIENT-001`

# Implementation tasks

1. Add password credential schema and indexes.
2. Implement password hash/verify flows and route handlers.
3. Issue sessions on successful password auth.
4. Implement `@authfn/client` methods for `getSession`, `signUpWithPassword`, `signInWithPassword`, and `signOut`.
5. Verify client uses cookie credentials and canonical envelopes.

# Verification steps

- Run `npm test --workspace @authfn/core -- password`
- Run `npm test --workspace @authfn/client`
- Manual flow: sign up, sign in, fetch current session, sign out
- Expected outcome: wrong passwords fail cleanly; successful sign-in yields cookies and session data.

# Stop condition

Report password hashing approach, client method names, and sign-in/sign-up response contracts.
