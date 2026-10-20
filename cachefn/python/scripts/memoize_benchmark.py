"""Populated synchronous memoization hit timings; run against source or an installed wheel."""

import json
import platform
import statistics
import time

from cachefn import memoize_sync

results = []
for ttl in [None, 3_600_000]:
    for keys in ["default", "custom"]:
        for size in [100, 1000, 10000]:
            kwargs = {"key_generator": str} if keys == "custom" else {}
            cached = memoize_sync(max_size=size, ttl=ttl, **kwargs)(lambda value: value)
            for value in range(size):
                cached(value)
            samples = []
            for index in range(2000):
                start = time.perf_counter_ns()
                assert cached(index % size) == index % size
                samples.append(time.perf_counter_ns() - start)
            samples.sort()
            results.append(
                {
                    "entries": size,
                    "ttl_ms": ttl,
                    "keys": keys,
                    "samples": len(samples),
                    "median_us": statistics.median(samples) / 1000,
                    "p99_us": samples[int(len(samples) * 0.99) - 1] / 1000,
                }
            )
            cached.clear()
print(
    json.dumps(
        {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "clock": "perf_counter_ns; individual warm hits; no baseline subtraction",
            "results": results,
        },
        indent=2,
    )
)
