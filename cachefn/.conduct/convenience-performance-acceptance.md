# V0 convenience API and performance — 2026-10-15

The original factory convenience surface is implemented: `cacheFn.memoize`, its
`.clear(fn)` helper, `cacheFn.middleware`, `cacheFn.hono`, and `cacheFn.fastify`.
Standalone imports remain available. The memory convenience wrapper preserves
synchronous return values and handles ordinary Promise-returning functions without
relying on async-function constructor detection. Persistent memoization remains
asynchronous. Memoized `.cache` is a real CacheFn using the same backing entries:
direct set/delete/clear and tag/pattern invalidation suppress stale pending fills.
Memory convenience manual writes use the original return type (including Promise
values); the standalone async wrapper/persistent wrappers store awaited results.

Validation: 183 tests across 16 files pass; source/schema typechecks and packed
ESM/CJS runtime plus NodeNext/Node16 consumers pass. Tests cover recursive sync
returns, Promise rejection/retry/single-flight, invalidation, raw persistent cache
values, cache-view coherence, middleware identity, and expiration cleanup.

## Reproducible benchmark

```sh
PLAYWRIGHT_MODULE_PATH=/Volumes/Dev/n/superfunctions/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node cachefn/typescript/scripts/benchmark.mjs
BROWSER_ENGINE=webkit PLAYWRIGHT_MODULE_PATH=/Volumes/Dev/n/superfunctions/node_modules/playwright \
node cachefn/typescript/scripts/benchmark.mjs
```

Raw output is in `benchmark-chromium.json` and `benchmark-webkit.json`. Host:
Apple M4 Pro, arm64, 14 logical CPUs, 24 GiB RAM, Darwin 27.0.0, Node 20.20.0.
Chrome 154.0.8037.58 and Playwright WebKit 26.0 used fresh temporary profiles.
WebKit is not native Safari certification. Cross-origin isolation permits finer
`performance.now` sampling: observed minimum ticks approximately 0.005 ms Chrome,
0.02 ms WebKit. Zero samples mean below timer resolution, not zero cost.

For each backend, 100 warm-up writes precede 10,000 sequential awaited numeric
entry sets, gets, and full-cache overwrites. Raw p50/p95/p99 are recorded without
baseline subtraction. Concurrent 1,000-read elapsed times are reported separately.
LRU tests use 1,000 measured writes at 1,000-entry capacity; pattern invalidation
uses 30 trials of 1,000 keys. Memoization hits include key generation, lookup and
await overhead, so measured hit latency is an upper bound on added memoization
cost for this cheap one-key workload.

| Original target | Chrome result | WebKit result |
| --- | --- | --- |
| Memory get/set p99 <1 ms | ~0.005 ms | ~0.02 ms |
| IndexedDB get/set p99 <10 ms | get 0.18 / set 0.23 ms | get 0.44 / set 0.76 ms |
| Memory overhead <200 B/entry | 172.43 B/numeric entry | not measured |
| LRU eviction at 1,000 entries <5 ms | p99 ~0.005 ms | p99 ~0.02 ms |
| Pattern invalidation 1,000 keys <50 ms | maximum 1.21 ms | maximum 3.90 ms |
| Memoization overhead <0.1 ms | hit p99 ~0.005 ms | hit p99 ~0.02 ms |

Retained-byte measurement uses Chromium CDP full garbage collection before/after
10,000 numeric values with string keys. Delta includes keys, metadata, indexes,
LRU and cache instance; it does not establish the target for arbitrary values,
long keys, tags, or other engines. Timing results are observations on this host,
not guarantees across hardware, browser versions, workloads or storage contention.

The initial `benchmark-before.json` captured a full-cache overwrite p99 around
0.1 ms with coarser 0.1 ms timing. MemoryStorage previously scanned every entry on
every at-capacity write. It now checks the earliest possible expiration before
sweeping, retaining reclamation-before-live-eviction semantics and avoiding full
scans when no TTL can have expired. Final overwrite p99 is ~0.005 ms in Chrome.
Because timing resolution changed, this comparison is directional, not a precise
speedup ratio. Expiration-triggered sweeps remain O(n); ordinary writes and LRU
bookkeeping avoid that scan.

Remaining original gates: 95% test coverage is not yet measured; actual current
SearchFn/AuthFn/BotFn/TestFn integration examples need validation; Firefox could
not launch on this host, and native Safari acceptance remains separate.
