# IndexedDB pattern invalidation and V0 performance evidence

Date: 2026-10-23. Baseline: `04d8a77fa`. Local source checkpoint only; no publication or deployment is implied.

## Problem and behavior

The original benchmark covered memory pattern invalidation but did not time the
IndexedDB path. Adding the equivalent 1,000-key case exposed a failure against
`V0_SPEC.md`'s unchanged `<50ms` target: enumeration followed by one transaction
per deletion took 146–164ms p99 in the final baseline comparisons.

Explicit IndexedDB storage now optionally implements `StorageBackend.deleteMatching`.
It snapshots primary keys and expired keys through the existing expiration index,
filters live keys within one readwrite transaction, and resolves removed keys only
after commit. CacheFn applies namespace and pattern matching inside that operation,
fences local pending fills, and emits delete/invalidate events and statistics after
commit. An abort rolls back all stored removals and reports no successful deletes.
Concurrent connections count only the records each transaction actually removes.
Public `deleteMany`, other storage methods, and custom backends without this optional
operation retain their existing behavior.

A missing or incompatible expiration index uses a transactional entry snapshot
without migrating the database. That path preserves compatibility but materializes
payloads; the fast-path measurements below do not establish its performance. The
indexed path still materializes O(total keys + expired keys) identifiers and scans
all keys. No constant-memory or arbitrary-size guarantee is made. Pending-fill
coordination is local to an instance, and an invalidation does not cancel the
caller's underlying fetch promise.

## Comparable final runs

All six final receipts use one identical harness hash and one source-bundle hash
per revision. The harness loads baseline source through `git show`; it does not
checkout, reset, or mutate source. Each pair ran baseline then candidate on installed
headless Google Chrome 154.0.8037.58, Node 22.22.0, macOS 27 arm64, Apple M4 Pro.
Other agents deferred heavy builds/browser tests during the windows. The third
baseline overlapped a reported short Python mypy process; small Python checks could
also overlap earlier windows. These are repeated local-host measurements, not an
exclusive-machine benchmark or cross-browser guarantee.

| Measurement | Baseline p99, pairs 1 / 2 / 3 (ms) | Candidate p99, pairs 1 / 2 / 3 (ms) | Strict target |
| --- | --- | --- | --- |
| IndexedDB, invalidate 1,000 of 1,000 | 164.085 / 146.175 / 151.150 | 21.595 / 18.895 / 22.045 | <50ms |
| Additional case: invalidate 1,000 of 10,000 | 327.745 / 194.785 / 193.865 | 26.070 / 27.160 / 26.145 | <50ms |

The original 10,000-entry get/set/overwrite, 1,000 concurrent reads, memory pattern,
LRU, and memoized-hit workloads remain. Each invalidation case has 30 independent
samples; its p99 is the maximum sample under the existing nearest-rank convention.
The extra 10,000-population case retains 9,000 nonmatching records and restores the
1,000 matching records before each trial. It is additional capacity evidence,
separate from the original 1,000-key pattern target.

Across all three final candidates:

| Measurement | Worst candidate p99 | Unchanged target |
| --- | --- | --- |
| Memory get / initial set / full-capacity overwrite | 0.005ms each | <1ms |
| Additional 10,000-entry-capacity memory replacement | 0.005ms | <1ms |
| IndexedDB get / initial set / overwrite | 0.180 / 0.120 / 0.150ms | <10ms |
| LRU replacement at 1,000 entries | 0.005ms | <5ms |
| Memory pattern invalidation, 1,000 keys | 0.915ms | <50ms |
| Async / sync / factory memoized hits | 0.005ms each | <0.1ms |

Full-GC retained-heap deltas for the 10,000-entry numeric fixture were **185.432,
185.543, and 185.301 bytes/entry**, all below the original **200-byte** target.
The delta includes string keys, metadata, indexes, LRU, and the instance; it is not
an arbitrary payload/tag-size guarantee. Timer resolution was approximately 0.005ms,
so timings at that resolution do not establish finer precision. Concurrent-read
elapsed times are reported without inventing an additional V0 threshold.

All measured targets passed in each final candidate. All final baselines failed
both IndexedDB invalidation cases and exited nonzero. Raw p50/p95/p99, counts,
heap measurements, host identity and hashes are retained in
[`indexeddb-pattern-performance-20261023.json`](indexeddb-pattern-performance-20261023.json).
The harness asserts values, counts, retained unrelated entries, eviction victims,
and replacements outside timed samples; it closes its owned browser at a
180-second workload deadline and exits nonzero for measured target failures.
On non-Chromium engines it is explicitly a partial measurement: no CDP heap
sample is available, `memory_measured` and `all_targets_pass` are false, and
exit zero only reports that the measured subset passed. Full-gate consumers
must check `all_targets_pass`, not exit status alone.

### Earlier unsuccessful approaches

The same evidence file retains every completed exploratory paired run, including
failures. A public batch-delete approach with cursor enumeration failed two of
three candidate trials (68.370 / 51.780 / 37.155ms). A batch-delete approach with
payload snapshot enumeration failed all three (57.120 / 51.610 / 69.690ms).
Transactional matching with payload snapshots passed the small case but failed the
additional 10,000-population case (53.505 / 305.515ms). Its third baseline completed,
but its third candidate was not started because the five-minute window expired.
Those implementations were superseded by the scoped key/index transaction above;
no public batch-delete or global enumeration change is retained. Workloads and
thresholds were not reduced to obtain the final passes.

## Correctness, packaging and commands

- Full Vitest: **262 tests / 20 files passed**, default parallel execution (1.46s).
  The serialized full suite also passed (5.30s).
- **15 new regression cases** cover missing/wrong indexes, inclusive expiry,
  index/predicate/delete failures, rollback, namespaces, regex state, reentrant
  observers, concurrent connection counts, pending fills, and custom-backend fallback.
- Installed Chrome native acceptance: **35 assertions passed**, including actual
  IndexedDB multi-delete abort rollback and successful namespace-scoped commit.
- Strict implementation and consumer type fixtures passed.
- ESM/CJS and `.d.ts`/`.d.cts` builds passed.
- Local tarball consumer passed strict TypeScript NodeNext/Node16 `.mts`/`.cts`
  compilation and ESM/CommonJS runtime smoke. This isolated fixture installation
  does not replace the separate full workspace normal-install gate.
- `git diff --check` passed. No dependencies, root metadata, or lockfile changed.

Earlier default-parallel runs during concurrent host builds hit existing HTTP
fixture timeouts. Their 28 HTTP cases passed in isolation with unchanged deadlines;
the final full default-parallel run passed all 262 tests. No test was disabled and
no timeout was increased.

Reproduction from repository root:

```sh
npm --prefix cachefn/typescript test
npm --prefix cachefn/typescript run typecheck
npm --prefix cachefn/typescript run build
node cachefn/typescript/scripts/packed-consumer.mjs
# With Playwright available (or PLAYWRIGHT_MODULE_PATH selecting its installation):
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node cachefn/typescript/scripts/browser-acceptance.mjs
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node cachefn/typescript/scripts/benchmark.mjs --ref=04d8a77fa
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node cachefn/typescript/scripts/benchmark.mjs
```

Local receipt logs: `/tmp/cache-index-{types,build,packed,native,full-tests,default-full-tests}-20261023.log`.
Final paired JSON files: `/tmp/cache-index-paired-{baseline,candidate}-{1,2,3}-20261023.json`.

## Remaining gates

The original Chrome/Firefox/native Safari browser matrix is not completed by this
checkpoint. Native Safari remains blocked by host remote-automation configuration
as recorded in [`native-safari-availability.md`](native-safari-availability.md);
Playwright WebKit is not native Safari evidence. Firefox was not rerun here.
Large/structured payloads, long-lived heap behavior, and the compatibility snapshot
path need their own measurements if applications depend on those distributions.
Python is outside the original V0 contract and was not changed or revalidated by
this TypeScript/IndexedDB slice. No hosted CI, registry, deployment, or live-provider
acceptance is asserted.
