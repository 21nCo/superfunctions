# Priority-filtered pending fetch invalidation

2026-10-20 UTC. `clear({priority})` previously examined stored keys only. A matching fetch for an absent key could finish after clear and repopulate the cache. Filtered clear now invalidates matching pending task identities before awaiting storage. An unset priority is normal. Priority metadata is associated with each pending promise in a WeakMap so superseded tasks do not leave a permanent metadata registry.

Filtering pending tasks by their own priority also preserves a high-priority refresh while clearing its older low-priority stored value. Existing task-identity checks prevent the superseded completion from writing or deleting a replacement task. Explicit writes retain their existing fencing behavior.

Validation: all223 TypeScript tests pass, including deferred matching low/normal/high fills for absent keys, nonmatching priorities, replacement-flight coalescing, explicit writes, and a high-priority refresh over a low-priority stored value. Typecheck and ESM/CommonJS/declaration build pass. The fresh packed TestFn/Vitest fixture acceptance was rerun after the runtime change and passes; the final CacheFn0.0.3 tarball SHA256 is `e7ac237ceb9469530d21085d40d672d1213aa6789a48cea5d630076919431ed3`. Other prerequisite hashes remain as recorded in `testfn-fixture-readiness.md`.

This correction fences fetches that have not yet been admitted to storage. It does not establish fully linearizable writes, metadata reads and deletes across arbitrary asynchronous adapters or independent cache instances. No Python implementation was changed; this priority-filtered API is TypeScript-specific.

Remaining concrete performance/lifecycle boundaries: object-form `getOrFetch` registers fetcher closures without a size bound, independently of entry eviction, and `dispose()` currently retains that registry. Standalone `memoizeSync` scans its whole cache for expiration before each lookup, including entries without TTL. The existing memoized-hit benchmark uses one warmed key and does not establish populated-cache overhead. These are open concerns, not changes included here. Native Safari/Firefox host gates also remain open.
