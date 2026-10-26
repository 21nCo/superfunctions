# CacheFn automatic pattern invalidation assessment

October 26, 2026. Inspected clean CacheFn delivery tree at `d473ca0c77748f9011e794f1403d7a6d27169786`. No implementation change was made.

`cachefn/typescript/src/storage/auto-storage.ts` does not expose optional `StorageBackend.deleteMatching`. Consequently `CacheFn.invalidateByPattern` uses its existing keys-plus-individual-deletes path for automatic storage, even when IndexedDB is selected. Explicit IndexedDB implements the optional operation using one transaction.

The interface describes `deleteMatching` as an optional atomic live-entry operation. The committed `cachefn/.conduct/indexeddb-pattern-performance-readiness.md` expressly scopes transactional rollback/post-commit notification guarantees to explicit IndexedDB and preserves other/custom backend behavior. Original SPEC lines306–308 describe pattern invalidation; lines659–662 configure automatic fallback. Neither establishes an additional cross-tier atomic invalidation guarantee.

A disposable focused diagnostic exercised public `storage:'auto'` with IndexedDB selected, two matching keys, one unmatched key and a separate namespace. Both matching values were removed, the unmatched and foreign values remained, and the emitted invalidation count was2. A transaction spy confirmed more than one transaction. Vitest4.1.11: one test passed, test time7ms; receipt `/tmp/cache-auto-pattern-diagnostic.log`. The first invocation used an obsolete `--minWorkers` option and was rejected before tests; the supported `--maxWorkers=1` invocation passed. The temporary fixture was removed afterward; CacheFn delivery tree remained clean with no owned processes.

Disposition: an unmeasured optimization candidate, not a reproduced correctness regression or proven performance failure. Forwarding the optional method unconditionally would advertise atomic capability after localStorage/memory fallback too. Automatic storage also treats `AbortError` as an availability failure and retries against its next tier, so delegation requires a deliberate capability/fallback contract rather than a trivial forwarding method. No benchmark, implementation, dependency change or publication is claimed.

## Bounded original-workload measurement attempt

After the BrowseFn heavy slot was released, an owned temporary derivative of the existing `cachefn/typescript/scripts/benchmark.mjs` extracted its unchanged 30-trial, 1,000-key `pattern:*` populate/verify/invalidate/verify block. The intended order was explicit IndexedDB control followed by public automatic storage, preserving strict p99 <50ms and the existing warmup. Other benchmark cases were deliberately not part of this requested measurement; it would not have constituted a full original performance-gate run.

The attempt stopped before bundling, browser launch or any timed sample: the existing harness could not resolve its `playwright` module (`MODULE_NOT_FOUND`, Node20.20.0). No dependency installation, profile/settings change or retry was performed. Error receipt: `/tmp/cache-auto-pattern-measurement.err`; no timing result was produced. The temporary derivative was removed and the CacheFn delivery tree remained clean. Therefore the auto-mode original performance target is still **unmeasured**, not passed or failed by this attempt.
