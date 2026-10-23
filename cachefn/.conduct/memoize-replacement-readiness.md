# Synchronous memoization full-capacity replacement

The earlier populated-hit checkpoint left full-cache miss/cleanup behavior open. Each replacement previously scanned every cached entry even without TTL or before any expiry. A conservative earliest-expiry hint now skips those scans. Deleted/evicted entries may leave an earlier hint, causing one unnecessary later scan; they cannot postpone a required scan. Due expiration still scans entries before evicting a live LRU value. Clear resets the hint, and stats retains exact live size.

Validation on Node20.20.0:264 core tests, both configured typechecks, and ESM/CJS/declaration builds pass. Ten expiry/capacity tests include expiration during computation, reentrant insertion, immediate TTL, deleted earliest expiry, clear with backward wall-clock movement and full-capacity LRU replacement. Python already has an earliest-expiry hint; it is unchanged and its earlier measurements are separate.

The existing browser benchmark now accepts --replacement. Each case seeds1/1000/10000 entries, warms2000 hits, then measures20000 distinct synchronous misses at full capacity with custom/default keys and absent/one-hour TTL. Computation counts, capacity, hits, eviction counts and result checksums are asserted. No baseline subtraction or await is inside timed calls. Replacement measurements have no invented pass threshold; the existing0.1ms target remains applicable only to the separate hit workload.

Actual Chrome154/macOS27 before/after final pair at10000 entries (milliseconds):

| Keys | TTL ms | Before p99 | After p99 |
| --- | --- | --- | --- |
| custom | None | 0.065 | 0.010 |
| custom | 3600000 | 0.060 | 0.010 |
| default | None | 0.065 | 0.010 |
| default | 3600000 | 0.095 | 0.010 |

Raw source-hashed observations, host metadata and all populations are retained in memoize-replacement-20261023.json. Baseline source is ba80e45718b2625e9b7d5978a3fa6974c749fac0. Initial pair before the benchmark separated replacement thresholds showed0.050–0.060ms before and0.010ms after; final pair above uses the final script. Initial launch could not resolve Playwright; rerun explicitly selected the existing CMS-worktree installation, with no dependency changes. Browser/session and localhost server are closed by the runner.

Run with PLAYWRIGHT_MODULE_PATH pointing to an installed Playwright, BROWSER_EXECUTABLE_PATH pointing to Chrome, then node cachefn/typescript/scripts/memoize-sync-benchmark.mjs --replacement [--ref=ba80e45718b2625e9b7d5978a3fa6974c749fac0]. Logs:/tmp/cache-memoize-replacement-{focused,full,types,build}.log.

These finite numeric-key/payload observations do not establish arbitrary payload/key costs, expired-population scan bounds, other engines, or deployed latency. Native Safari/Firefox performance and remaining original requirements stay open. No settings changes, release or deployment.
