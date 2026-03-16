# PHASE 12

## Phase goal
Deliver shared metrics/config/auth bearer/rate-limit components and migrate recfn/plugfn.

## In scope / Out of scope

- **In scope:** new shared utility packages/extensions and adoption in recfn/plugfn.
- **Out of scope:** deep provider-specific policy logic.

## Deliverables

- `packages/metrics` and `packages/config` packages.
- `@superfunctions/auth` bearer extraction/middleware additions.
- Shared rate-limit algorithm-complete implementation and adoption wrappers.

## Requirements covered

- REUSE-008
- REUSE-009
- REUSE-010
- REUSE-011
- REUSE-012

## Implementation tasks

1. Implement metrics package and migrate recfn metrics emitter wrappers.
2. Implement config package and migrate recfn env limit loaders.
3. Extend auth package with bearer helpers and migrate recfn auth middleware.
4. Implement/extend shared rate-limit with fixed/sliding/token-bucket support.
5. Migrate recfn and plugfn rate limiting to shared core.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/metrics run test
npm -w @superfunctions/config run test
npm -w @superfunctions/auth run test
npm -w @superfunctions/middleware run test
npm -w recfn-server run test
npm -w plugfn run test -- retry-ratelimit.test.ts
```
Expected: shared package and consumer tests pass.

2. Run:
```bash
rg -n "algorithm\?: 'sliding-window'|'fixed-window'" packages/middleware/src/rate-limit.ts
```
Expected: option is implemented and tested, not dead config.

## Stop condition
Shared utility extraction is complete and recfn/plugfn rely on shared implementations.
