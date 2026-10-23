# Phase goal

Harden `plugfn` HTTP route auth boundaries, webhook verification, and request transport correctness.

## In scope / Out of scope

- **In scope**:
  - Auth context enforcement for API routes.
  - Fail-closed webhook signature and secret handling.
  - Webhook event mapping canonicalization.
  - Content-type aware HTTP request handling.
- **Out of scope**:
  - Rate-limiter distribution and workflow crash recovery.
  - Email provider adapters.

## Deliverables

- `plugfn/typescript/src/router/http-router.ts`
- `plugfn/typescript/src/webhooks/webhook-handler.ts`
- `plugfn/typescript/src/utils/request.ts`
- `plugfn/typescript/src/types/action.ts`
- `plugfn/typescript/tests/router-auth.test.ts`
- `plugfn/typescript/tests/webhook-verification.test.ts`
- `plugfn/typescript/tests/http-client-content-type.test.ts`

## Requirements covered

- PLUG-001
- PLUG-002
- PLUG-003
- PLUG-005

## Implementation tasks

1. Replace query/body-based identity trust with middleware-derived identity context.
2. Implement strict secret lookup and signature verification gates.
3. Introduce explicit provider-event mapping table and validation.
4. Update HTTP client serialization strategy by content type.
5. Add deterministic error responses for validation and security failures.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/router-auth.test.ts tests/webhook-verification.test.ts tests/http-client-content-type.test.ts`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm run type-check`
3. `rg -n "ctx.query.get\('userId'\)|Missing userId" /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/router/http-router.ts`
Expected outcome: targeted tests pass and route identity anti-patterns are removed.

## Stop condition

Route auth and webhook verification are fail-closed, and transport tests prove content-type correctness.
