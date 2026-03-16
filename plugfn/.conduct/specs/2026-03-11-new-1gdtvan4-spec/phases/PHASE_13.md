# Phase goal

Integrate `authfn` social OAuth sign-in using shared OAuth primitives without duplicating OAuth core logic.

## In scope / Out of scope

- **In scope**:
  - Social login URL + callback handling in `authfn`.
  - Provider descriptors reuse from shared package.
  - Identity record persistence and disconnect flow.
- **Out of scope**:
  - Full consumer UI for social account management.

## Deliverables

- `authfn/ts-sdk/src/social-oauth/index.ts`
- `authfn/ts-sdk/src/social-oauth/types.ts`
- `authfn/ts-sdk/src/social-oauth/provider-map.ts`
- `authfn/ts-sdk/src/index.ts` (exports update)
- `authfn/ts-sdk/README.md` (social OAuth section)
- `authfn/ts-sdk/tests/social-oauth.test.ts`

## Requirements covered

- OAUTH-007
- OAUTH-008
- OPS-002
- OPS-004

## Implementation tasks

1. Add social OAuth configuration and service wiring to `authfn`.
2. Reuse shared OAuth service and provider descriptors.
3. Persist linked identity records and disconnect semantics.
4. Ensure API-key authentication behavior remains unchanged.
5. Add tests proving no duplicate OAuth core implementation.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk && npm run typecheck`
2. `cd /Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk && npm test -- --run`
3. `rg -n "oauth-flow|token exchange|authorizationUrl" /Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src`
Expected outcome: tests pass and shared OAuth imports are used.

## Stop condition

`authfn` social OAuth flow is functional and demonstrably built on shared OAuth packages.
