# Reproducible Python type checks

2026-10-20. The unrestricted dev tool dependency selected mypy versions that no
longer accept Python 3.9 as a target. Optional psutil stubs were also absent.
On Python 3.12, Redis's newer annotations expose RESP2/RESP3 and decoded/binary
unions that the old stream code assumed away.

The dev extra now selects mypy 1.18.x and includes types-psutil. The target follows
the active Python interpreter instead of parsing Python 3.12-only dependency
syntax as Python 3.9. Both supported endpoints are checked separately; no runtime
minimum was raised and no Redis dependency ceiling was added.

The adapter explicitly selects decoded RESP2, validates the stream entry shape,
and defines an asynchronous raw-command boundary for Lua. This replaces
version-dependent eval overload casts without suppressing diagnostics or changing
lease/acknowledgement scripts.

From `flowfn/python`:

```sh
uv run --isolated --no-project --python 3.9 --with '.[dev,redis,postgres]' mypy flowfn
uv run --isolated --no-project --python 3.12 --with '.[dev,redis,postgres]' mypy flowfn
```

Both pass all 47 source files. Logs: `/tmp/flowfn-types-3.9-final.log` and
`/tmp/flowfn-types-3.12-final.log`.

Fresh installed-wheel native acceptance after the final source change passes
189 tests with six backend-specific skips on Python 3.12 and Python 3.9.
Logs: `/tmp/flowfn-python-wheel-types-final-312.log` and
`/tmp/flowfn-python-wheel-types-isolated-39.log`. Site-packages imports, actual
Redis/PostgreSQL operations and owned container cleanup were verified.

An earlier Python 3.9 run overlapped the TypeScript provider benchmark and failed
the PostgreSQL one-second lease heartbeat assertion (188 passed, six skipped).
The unchanged-code repeat after benchmark load stopped passed. This is evidence
of timing-sensitive acceptance under concurrent host load, not proof of its
cause or a fixed heartbeat defect. The assertion and lease duration were not
weakened. Log: `/tmp/flowfn-python-wheel-types-final-39.log`. Stable loaded-host
heartbeat/performance acceptance remains open, as do the broader original gates.
