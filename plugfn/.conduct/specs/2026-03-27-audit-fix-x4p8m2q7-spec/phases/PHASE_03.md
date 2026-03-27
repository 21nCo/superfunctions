# Phase goal

Harden the TypeScript router and webhook surface so auth is derived from configured auth providers and signatures are verified against raw bytes.

# In scope / Out of scope

- In scope: TypeScript router auth defaults, request envelopes, raw-body webhook verification, provider signature regressions
- Out of scope: workflow durability, Python parity

# Deliverables

- `plugfn/typescript/src/router/http-router.ts`
- `plugfn/typescript/src/webhooks/webhook-handler.ts`
- `plugfn/typescript/src/providers/github/index.ts`
- `plugfn/typescript/src/providers/linear/index.ts`
- `plugfn/typescript/src/providers/clickup/index.ts`
- `plugfn/typescript/src/providers/gmail/index.ts`
- `plugfn/typescript/tests/router-auth.test.ts`
- `plugfn/typescript/tests/webhook-raw-body.test.ts`
- `plugfn/docs/getting-started.md`

# Requirements covered

- `ROUTER-001`
- `AUTH-001`
- `WEBHOOK-001`

# Implementation tasks

1. Make the router default to `plugFn.config.auth.authenticate` unless an explicit override is supplied.
2. Reject unauthenticated non-webhook routes with `PLUGFN_AUTH_REQUIRED`.
3. Validate caller-supplied identity fields against the derived principal and fail with `TENANT_ACCESS_DENIED` on mismatch.
4. Preserve raw request bytes through webhook verification and only parse JSON after successful verification.
5. Add provider regression tests for GitHub, Linear, ClickUp, and Gmail signature verification against raw bytes.
6. Update getting-started docs to show the canonical auth-derived route mounting story.

# Verification steps

- Run `npm test --workspace plugfn -- --run plugfn/typescript/tests/router-auth.test.ts plugfn/typescript/tests/webhook-raw-body.test.ts`
- Run `rg -n "JSON.stringify\\(payload\\)|Bearer .* as userId|query.get\\('userId'\\)" plugfn/typescript/src/router plugfn/typescript/src/webhooks plugfn/typescript/src/providers`
- Expected outcome: targeted tests pass and no raw-body/signature/auth anti-patterns remain in the targeted TypeScript surface.

# Stop condition

Report the final route inventory and the provider files that now verify against raw bytes.
