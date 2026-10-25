# Memory queue insertion order

The built TypeScript memory adapter returned a,b,c for three LIFO jobs inserted at
the same mocked millisecond. Its comparator used timestamps, with stable sorting
retaining FIFO order on ties. Mixed FIFO/LIFO comparison also depended on both
operands, and explicit re-enqueue did not move a Map entry when timestamps tied.
Three focused regressions fail on the preceding source; the dependency/delay/name
filter regression passes there. Receipts: /tmp/flow-memory-order-before.log.

Selection now scans Map insertion order once, retaining the earliest FIFO candidate
or latest LIFO candidate at the highest priority. LIFO entries precede FIFO entries
at equal priority, matching Redis's explicit queue-member grouping. Explicit enqueue
deletes/reinserts only after lease/dedup validation and snapshot construction; normal
save retains the existing position. No per-job metadata, sequence counter, sorted
array or public schema is added. Delays and leases retain clock-based deadlines.

Four focused regressions pass (/tmp/flow-memory-order-after.log): same-millisecond
LIFO, clock regression/mixed priority, requeue versus save ordering, and blocked
dependency/future-delay/name filtering. Full source suite: 163 passed, 81 provider-dependent tests skipped (29 passed files, two skipped). Source and test typechecks, ESM/CJS/declaration builds and built ESM/CJS ordering smoke checks pass on Node20.20.0. Receipts: /tmp/flow-memory-order-{full,types,test-types,build}.log. External provider suites were not rerun because their source is unchanged.
No performance benchmark or throughput improvement is claimed.

Python inspection: JobOptions has no LIFO field; its memory adapter uses stable
priority sorting on a list. No Python code changed, and this is not Python parity
evidence. PostgreSQL's current timestamp-based ordering can still tie within a
millisecond; a durable insertion-order migration and native validation remain open.
Existing Redis throughput/enqueue latency, PostgreSQL latency, memory and wider
original readiness requirements remain open.
