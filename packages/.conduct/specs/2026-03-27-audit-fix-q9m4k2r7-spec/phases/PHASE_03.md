# Phase goal

Harden `oauth-router` so generated routes are secure by default and still overrideable by consumers.

# In scope / Out of scope

- In scope: route metadata defaults, per-route overrides, router tests
- Out of scope: docs page content, provider-policy persistence, release gate

# Deliverables

- `packages/oauth-router/src/index.ts`
- `packages/oauth-router/src/browser-routes.ts`
- `packages/oauth-router/src/connection-routes.ts`
- `packages/oauth-router/src/__tests__/routes.test.ts`

# Requirements covered

- `ROUTER-001`
- `TEST-001`

# Implementation tasks

1. Add route metadata override support to both route factory configs.
2. Apply secure default metadata by route type.
3. Preserve callback public accessibility while hardening connection and disconnect routes.
4. Extend route-factory tests to assert default metadata and explicit override behavior.
5. Ensure request-ID propagation and route paths remain unchanged unless this spec explicitly changes them.

# Verification steps

- Run `npm test --workspace @superfunctions/oauth-router`
- Expected outcome: connection routes are no longer public by default, browser disconnect is authenticated by default, and explicit overrides still work.

# Stop condition

Report the default auth mode chosen for each generated route and how overrides replace those defaults.

