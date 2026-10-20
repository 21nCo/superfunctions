# Populated memoizeSync hit performance

2026-10-20. The synchronous TypeScript memoizer previously scanned every cached
entry for expiry before every lookup, including caches with no TTL. A warmed
single-key benchmark did not expose the resulting population-dependent hit cost.

## Behavior

A lookup now checks expiry only for the requested key and updates its LRU order
on a live hit. Hits do not renew TTL. An expired key is removed and recomputed at
the exact `now >= expiresAt` boundary; expiration does not count as eviction.
Undefined values remain cacheable. No TTL and `Infinity` retain their existing
non-expiring behavior, and zero capacity still prevents caching.

Cold expired entries are reclaimed when an insertion needs capacity and when
`stats()` requests an exact live-entry count. Capacity cleanup occurs after the
wrapped function returns, so expiry during a slow computation and entries added
by recursive calls are accounted for before evicting a live LRU entry. The cache
remains bounded by `maxSize`. Clear/delete controls and statistics retain their
existing contracts. No expiry queue, timer, or secondary retention structure was
introduced.

A live hit performs one expiry check plus amortized constant-time Map operations,
independent of population apart from key generation and occasional engine Map
maintenance/GC. A full-cache miss and `stats()` still scan O(n) entries. This
checkpoint does not claim constant-time insertion or cleanup. Lazy expiry is
consistent with SPEC and V0_SPEC; expired values are never returned just because
physical cleanup is deferred.

## Tests

Dedicated cases cover an expired MRU entry alongside a live LRU entry, exact TTL
boundaries and undefined values, cold-entry statistics, expiry during computation,
recursive cache filling, 1,000 non-expiring entries, delete/clear, and immediate
expiry. The existing synchronous/async memoization tests also pass.

```sh
npm test -w @cachefn/core -- --run __tests__/memoize.test.ts __tests__/memoize-sync-expiry.test.ts
npm run typecheck -w @cachefn/core
npm test -w @cachefn/core
```

Results at this checkpoint: 18 focused memoization tests; 231 full TypeScript
tests; production and public type-contract checks passed. Concurrent core registry
changes have separate evidence and are not included in this implementation claim.

## Populated browser benchmark

`scripts/memoize-sync-benchmark.mjs` measures actual synchronous calls, without
`await` or baseline subtraction. Each case seeds 1, 1,000 or 10,000 entries,
warms 2,000 round-robin hits, then measures 20,000 further round-robin hits. It
covers default argument hashing and a custom key generator, each with no TTL and
a finite one-hour TTL. Assertions verify population, computations, hit counts and
zero eviction, so an empty or repeatedly recomputed cache cannot pass as a hit
benchmark. The original V0 memoization target remains <0.1 ms; reported pass uses
p99, consistent with the existing browser benchmark.

The harness can load the memoizer from a Git revision without modifying the
working tree. Output records the exact memoizer source SHA256, revision/working
source selection, host, browser, timer resolution, statistics and checksum.
Other source dependencies come from the current checkout.

```sh
export PLAYWRIGHT_MODULE_PATH=/path/to/playwright
export BROWSER_EXECUTABLE_PATH=/path/to/chrome
node cachefn/typescript/scripts/memoize-sync-benchmark.mjs --label=before --ref=fe5b036d035cf76616514d5360237acdbdd0a50e
node cachefn/typescript/scripts/memoize-sync-benchmark.mjs --label=after
```

Local acceptance used Apple M4 Pro / macOS Darwin 27 arm64, Node 20.20.0 and real
Chrome 154.0.8037.58. Cross-origin isolation was enabled; observed timer resolution
was approximately 0.005 ms. Raw outputs are [before](memoize-sync-before.json)
and [after](memoize-sync-after.json).

| 10,000-entry case | Before p99 (ms) | After p99 (ms) |
| --- | ---: | ---: |
| Custom key, no TTL | 0.055 | 0.005 |
| Custom key, finite TTL | 0.060 | 0.005 |
| Default key, no TTL | 0.060 | 0.005 |
| Default key, finite TTL | 0.065 | 0.005 |

All 12 after cases met the original 0.1 ms target on this host. The baseline also
met it for these populations; the correction removes its per-hit linear scan,
not a claimed target failure. After p99 is at the timer's resolution: these
numbers do not establish nanosecond precision, a universal speedup factor, or
performance on other hardware. Maximum latency and means remain in the raw
outputs so percentile reporting does not hide outliers.

## Remaining original gates

Full-cache miss/cleanup performance, arbitrary key/payload sizes, other browser
engines and deployment environments are not established by this hit benchmark.
Native Safari and Firefox acceptance remains separate. Python was inspected but
not changed: its synchronous memoizer still scans for expiry; this TypeScript
checkpoint is not Python performance evidence. Original full-SPEC capabilities,
packaging/provider/browser/runtime and broader readiness gates retain their
existing scope; no single benchmark establishes complete production readiness.
