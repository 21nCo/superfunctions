# Coverage and current ecosystem integration — 2026-10-15

The original V0 wording is “95%+ test coverage” (success criteria and production
readiness section). It does not specify statements, branches, functions, or lines.
The existing Vitest configuration had a V8 provider but no numerical thresholds;
no threshold was lowered and no production source exclusion was added.

`npm --prefix cachefn/typescript run test:coverage` passes 217 tests / 17 files:

| Metric | Covered / total | Percentage |
| --- | --- | --- |
| Statements | 1343 / 1402 | 95.79% |
| Branches | 814 / 900 | 90.44% |
| Functions | 335 / 352 | 95.17% |
| Lines | 1048 / 1059 | 98.96% |

The raw aggregate is retained in `coverage-summary.json`; the command regenerates
full per-file reports in the ignored `typescript/coverage/` directory. These
measurements support the general 95% statement/line/function claim, not a 95%
branch-coverage claim. Remaining branches include browser initialization/error
callbacks and alternative middleware/configuration paths. Tests were extended for
malformed persistent serialization, observer failures, expiration boundaries,
nonresponsive storage probes, public utility behavior, denied durable queue
writes/cancellation, and shared memoization-cache invalidation. The test-only
coverage dependency is pinned to the matching Vitest version 4.1.11. Lock changes
are scoped to that direct dependency and optional/peer flags of its already-locked
transitive packages; no unrelated versions were moved.

## Current integration examples

`npm --prefix cachefn/typescript run test:ecosystem` typechecks the examples and
current workspace APIs, bundles their actual implementations, and executes:

- SearchFn `@searchfn/adapter-memory`: index real documents, cache complete query
  options, hit cache, index another document, invalidate resource tags, remove a
  document, and observe current results. Caller-owned abort signals bypass shared
  caching so cancellation ownership is preserved.
- AuthFn `authfn`: initialize the actual app/server with the shared memory database
  adapter, create a real user/session through public core exports, authenticate an
  issued cookie, cache profile data, then revoke the session and verify the cached
  profile does not bypass fresh authentication. No authentication/authorization
  result is memoized by this example.
- BotFn `@superfunctions/botfn-slack-core`: sign real Slack request bodies using
  HMAC, verify with the current BotFn implementation, deduplicate two concurrent
  event deliveries, and reject a bad signature even when the event is cached.

Source: `typescript/examples/ecosystem.ts`; reproducible runner and scenarios are
in `typescript/scripts/ecosystem-acceptance.mjs` and `ecosystem-scenarios.ts`.
Source/schema checks also pass via `npm --prefix cachefn/typescript run typecheck`.
The runner uses actual workspace source aliases, not fabricated module APIs or
mock provider implementations. It does not establish published-registry package
availability or live Slack delivery. It adds no runtime dependencies to CacheFn.

TestFn is not present on the development branch, so its original integration
example remains pending the actual package port. Native Safari acceptance and the
Firefox host launch failure remain separate browser gates. The public dependency
release sequence is recorded in `release-contract.md`; local tarball acceptance
must not be presented as a patched public registry dependency graph.
