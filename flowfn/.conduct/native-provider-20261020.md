# Native provider acceptance and Redis script caching

Docker Desktop was started locally and reported server 29.8.1. Disposable
loopback-only Redis7-alpine/PostgreSQL16-alpine services were created by the
existing acceptance runner; all owned containers were removed and read back.
Unrelated containers were not modified.

The first TypeScript run passed59 native tests. The initial Python3.12 run
passed175 and failed2 retention assertions that expected silent stale ack. The
existing durable ownership contract explicitly rejects stale delivery attempts;
the retention test now requires that error, still proves pending/unread records
remain retained, and proves a replacement consumer drains them. No product
behavior was weakened to satisfy these tests. Final Python3.9 and3.12 runs each
pass177 tests with6 backend-specific skips and4 existing Pydantic deprecation
warnings. These are source runs with native extras, not wheel tests.

The runner now supports --python and FLOWFN_PYTHON_VERSION, defaults to3.12,
and attempts cleanup for every owned container even if one cleanup fails.

Redis previously transmitted the complete fixed Lua source on every operation.
It now caches SHA1 script identities locally and invokes EVALSHA. Only explicit
NOSCRIPT may fall back to EVAL; transport/auth/script errors propagate without
blind replay. Native tests exercise cold cache, warm cache, SCRIPT FLUSH recovery,
three distinct persisted jobs, and no EVAL fallback after an ambiguous transport
error. All61 native TypeScript tests, source/test typechecks and builds pass.

## Measurements and limits

Node20.20.0, 1000 jobs,32 concurrent producers,16 handlers, local Docker. The
unchanged benchmark includes memory/metrics overhead and runs on a development
machine with other work. The before/after samples are not statistical proof:

| Adapter | Before jobs/sec | After jobs/sec | After enqueue p99 ms | After dequeue p99 ms | After queue-to-handler p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Redis | 6012.66 | 6472.64 | 9.84 | 4.25 | 74 |
| PostgreSQL (unchanged) | 983.78 | 1215.21 | 22.19 | 15.77 | 480 |

Redis still misses10000 jobs/sec and enqueue p99<5ms. PostgreSQL throughput
varied across1000 jobs/sec and still misses enqueue<5ms, dequeue<10ms and
queue-to-handler<100ms. All original targets remain gates; no threshold was
relaxed. Raw result lines are in native-queue-measurements-20261020.json.

Receipts: /tmp/flowfn-native-script-cache-20261020.log,
/tmp/flowfn-python-native-target-final-20261020.log,
/tmp/flowfn-python-native-39-20261020.log. Original D1/SQS/Kafka, partitions,
full parity, deployment and other specification requirements remain incomplete.
