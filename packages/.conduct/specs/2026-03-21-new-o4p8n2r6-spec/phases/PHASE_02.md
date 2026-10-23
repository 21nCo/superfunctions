# Phase goal

Extend `oauth-flow` and add reusable route factories in `oauth-router`.

# In scope / Out of scope

- In scope: `oauth-flow`, new `oauth-router`
- Out of scope: provider registry updates and OpenAPI generation

# Deliverables

- `packages/oauth-flow/src/service.ts`
- `packages/oauth-flow/src/index.ts`
- `packages/oauth-flow/src/__tests__/browser-auth-flow.test.ts`
- `packages/oauth-router/package.json`
- `packages/oauth-router/tsconfig.json`
- `packages/oauth-router/src/index.ts`
- `packages/oauth-router/src/browser-routes.ts`
- `packages/oauth-router/src/connection-routes.ts`
- `packages/oauth-router/src/__tests__/routes.test.ts`

# Requirements covered

- `OAUTH-FLOW-001`
- `OAUTH-ROUTER-001`

# Implementation tasks

1. Teach `oauth-flow` to accept browser-auth intents and post-callback identity resolution hooks.
2. Add redaction-safe events and structured hook failure behavior.
3. Create `oauth-router` route factories on top of `@superfunctions/http`.
4. Add tests for redirect/json completion modes.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-flow`
- Run `npm test --workspace @superfunctions/oauth-router`
- Expected outcome: route factories produce reusable routes and browser-auth callbacks complete without requiring a pre-known user.

# Stop condition

Report the route factory API and the updated `oauth-flow` callback contract.
