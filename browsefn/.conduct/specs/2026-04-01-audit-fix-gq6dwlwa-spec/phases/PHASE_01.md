# Phase goal

Make the TypeScript core package buildable and align its cache, rate-limit, retry, observability, and router infrastructure with the canonical contract.

## In scope / Out of scope

- **In scope**:
  - TypeScript typecheck/build fixes
  - shared rate-limit integration
  - cache normalization
  - retry wiring
  - metrics/logging/event wiring
  - canonical router envelopes and status mapping
- **Out of scope**:
  - Firecrawl and Jina behavior
  - image download correctness
  - geo provider completion

## Deliverables

- `browsefn/typescript/src/core/browse-fn.ts`
- `browsefn/typescript/src/core/cache-manager.ts`
- `browsefn/typescript/src/core/rate-limiter.ts`
- `browsefn/typescript/src/core/types.ts`
- `browsefn/typescript/src/middleware/retry.ts`
- `browsefn/typescript/src/middleware/logging.ts`
- `browsefn/typescript/src/middleware/metrics.ts`
- `browsefn/typescript/src/router/http-router.ts`
- `browsefn/typescript/tests/cache-manager.test.ts`
- `browsefn/typescript/tests/rate-limiter.test.ts`
- `browsefn/typescript/tests/provider-manager.test.ts`

## Requirements covered

- CACHE-001
- RATE-001
- ERR-001
- OBS-001
- HTTP-001
- SHARED-001

## Implementation tasks

1. Replace TypeScript local rate-limit algorithm logic with a wrapper around `@superfunctions/middleware/rate-limit`.
2. Normalize cache config handling, including `ttl` versus `defaultTTL`.
3. Wire retry, logging, metrics, and events into actual request execution paths.
4. Implement canonical router success/error envelopes and stable status-code mapping.
5. Make `npm --prefix browsefn/typescript run build` and `typecheck` pass cleanly.

## Verification steps

1. Run `npm --prefix browsefn/typescript run build`.
Expected: build exits `0`.
2. Run `npm --prefix browsefn/typescript run typecheck`.
Expected: typecheck exits `0`.
3. Run `npm --prefix browsefn/typescript run test -- --run`.
Expected: core/cache/rate-limit/provider tests pass.

## Stop condition

Report the shared rate-limit import path, the router envelope helper path, and the first clean TypeScript build/typecheck run.
