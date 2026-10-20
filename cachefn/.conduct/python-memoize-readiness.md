# Python populated synchronous memoization hits

2026-10-20 UTC. `MemoizedSyncFunction._purge_expired()` previously copied and scanned every cached entry before each synchronous lookup, including wrappers with no TTL. At 10,000 entries this dominated even a simple cached result.

The wrapper now retains an earliest-expiration lower bound. Before that deadline, lookups and statistics skip the entry scan. A due sweep removes expired entries and computes the next deadline; inserts lower the hint and `clear()` resets it. Deleting or evicting the earliest entry may leave a conservative early hint, causing an extra sweep rather than serving an expired value. No heap, timer, background task or extra per-entry index was introduced.

TTL still begins after the function returns and is not extended by hits. Expired entries are removed before capacity eviction. LRU promotion, falsy results, exception propagation, reentrant calls and statistics preserve their prior behavior. Async memoization was not changed.

## Local measurements

`python/scripts/memoize_benchmark.py` measured 2,000 individual warm hits per case using `perf_counter_ns`, with no baseline subtraction, on Python 3.12.12/macOS 27 ARM64. Each cache was populated before timing; cases cover 100/1,000/10,000 entries, absent/one-hour TTL, and default/custom keys. Before used the preceding implementation; after used the expiration hint. These are finite local observations, not latency guarantees.

Median microseconds per hit with the default canonical key generator:

| Entries | No TTL before | No TTL after | One-hour TTL before | One-hour TTL after |
| --- | --- | --- | --- | --- |
|100|11.375|6.750|11.583|6.708|
|1,000|51.875|6.708|57.042|6.708|
|10,000|813.875|6.750|887.833|6.667|

At 10,000 entries, a custom `str` key reduced median hits from 772.416µs to 0.500µs without TTL and from 855.042µs to 0.500µs with a one-hour TTL. Default-key p99 at 10,000 entries changed from 882.542µs to 11.000µs without TTL and from 982.459µs to 7.375µs with TTL. The custom-key cases separate expiry maintenance from canonical key encoding cost.

Reproduce after-checks from the repository root:

```sh
PYTHONPATH=cachefn/python uv run --no-project --python 3.12 --with 'pydantic>=2.5' python cachefn/python/scripts/memoize_benchmark.py
```

## Validation and boundaries

- Python 3.12 source: 65 tests pass, including the existing eager task-factory ownership/cancellation cases.
- Python 3.10 and 3.11: 62 tests pass and 3 eager-factory cases skip because those runtimes lack that API.
- 10 new deterministic cases cover populated no-scan hits, expiration boundary, completion-time TTL, expiration-before-eviction, LRU, delete/clear, zero TTL/falsy values, failure retry, and reentrant capacity/TTL. Iteration instrumentation verifies populated hits do not walk entries without relying on a wall-clock threshold.
- A fresh `cachefn-0.0.1-py3-none-any.whl` was built and installed into an isolated Python 3.12 environment. Copied tests plus an installed-module-origin check pass 66 tests with importlib collection, without source-tree imports. Temporary consumer files were removed.

Reproduce source tests by changing the Python version in:

```sh
PYTHONPATH=cachefn/python uv run --no-project --python 3.12 --with 'pydantic>=2.5' --with pytest --with pytest-asyncio python -m pytest cachefn/python/tests -q
```

A due expiration sweep remains O(n); stale early hints can cause a conservative sweep after deletion/eviction. Default key generation cost is separate. Cache wrappers remain intended for one thread; cross-thread access requires external synchronization. This does not add async lifecycle behavior or TypeScript refresh/offline-registry parity, and it is not overall production-readiness, registry publication or deployment evidence.
