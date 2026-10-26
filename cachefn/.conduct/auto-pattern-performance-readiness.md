# Automatic IndexedDB pattern invalidation

The V0 specification requires pattern invalidation of 1,000 keys in under 50 ms
at p99. The existing public `auto` backend omitted the selected IndexedDB tier's
bulk capability, performing individual transactions instead. On baseline
`d473ca0c77748f9011e794f1403d7a6d27169786`, the original 30-trial workload exceeded
that target for both auto and explicit IndexedDB.

`AutoStorage.tryDeleteMatching` now checks the selected tier after preceding
queued operations settle. It returns `undefined` when no atomic operation was
attempted, preserving localStorage/memory/custom-backend fallback behavior. On
IndexedDB, it delegates the complete operation and propagates transactional
failure without replaying into another tier. Ordinary operation failover is
unchanged. Successful deletion statistics and events remain commit-only.

IndexedDB scans the full key/expiry set and evaluates every live predicate before
removing anything. If all stored keys are expired or matched, a single `clear`
request replaces the individual deletion requests. A foreign namespace or any
unmatched live key prevents clearing. The old/missing-expiry-index path retains
its full-record scan and the same eligibility rule. Throwing predicates abort;
expired keys are excluded from returned deletion counts.

## Validation

- `npm test -w ./cachefn/typescript`: 271 tests in 20 files passed.
- `npm run typecheck -w ./cachefn/typescript`: source and schema type tests passed.
- `npm run build -w ./cachefn/typescript`: ESM, CommonJS and declarations passed.
- Native Chromium 143.0.7499.4: 43 browser assertions passed, including actual
  auto transaction abort, no success events/fallback replay, namespace isolation,
  expired-key exclusion and predicate failure. Existing offline synchronization
  assertions also passed. No Safari settings or user browser sessions changed.
- Fresh local tarball: ESM/CommonJS runtime and strict schema consumers under
  TypeScript 5.9.3/NodeNext/Node16 passed. Installed auto bulk commit, abort and
  retained-tier tests use fake-indexeddb; native evidence is the source browser
  fixture above, not an installed-browser claim.

The first focused run passed 33 tests and failed one existing fault injector
because the all-match path now calls `clear`, not `delete`. That test now retains
its individual-delete rollback purpose with an unmatched key. Separate native
and unit abort cases cover bulk clearing. Final full results include these cases.

## Unchanged native workload

`typescript/scripts/auto-pattern-benchmark.mjs` extracts the original
`benchmark.mjs` block: 30 trials, 1,000 keys per trial, population/empty checks,
100-operation warmup and strict p99 < 50 ms. It runs explicit IndexedDB followed
by public auto. `--ref` bundles exact committed source without changing checkout.
Raw samples, source/bundle/workload hashes and browser version are in
`auto-pattern-performance-20261026.json`.

| Isolated run | Explicit IndexedDB p99 | Auto p99 |
| --- | ---: | ---: |
| Exact baseline d473ca0c | 72.070 ms | 138.070 ms |
| Candidate, following baseline | 7.865 ms | 3.545 ms |
| Earlier isolated candidate repeat | 9.020 ms | 9.420 ms |

Initial measurements are retained separately; possible overlapping short work
makes them supporting observations only. The final baseline/candidate pair ran
after other agents explicitly released their test windows. Every sample is
retained; no threshold, population, trial count or slow-sample exclusion changed.
This establishes the specified 1,000-key pattern target on this Chromium host.
It does not rerun or establish all V0 performance, memory, browser or fallback-tier
gates. Partial-match workloads still use individual deletion requests in one
transaction; no universal sub-50-ms claim is made for them.

Reproduce from the repository root (point `PLAYWRIGHT_MODULE_PATH` at an installed
matching Playwright/browser toolchain when it is not locally available):

```sh
node cachefn/typescript/scripts/auto-pattern-benchmark.mjs --ref=d473ca0c77748f9011e794f1403d7a6d27169786
node cachefn/typescript/scripts/auto-pattern-benchmark.mjs
node cachefn/typescript/scripts/browser-acceptance.mjs
node cachefn/typescript/scripts/packed-consumer.mjs
```

All fixtures use private browser contexts/loopback origins or temporary package
consumers and close/remove their owned resources in `finally`. Logs remain in
`/tmp/cache-auto-*`; no background browser, server or test process is retained.
