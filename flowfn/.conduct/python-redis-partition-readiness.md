# Python Redis partition protocol

## Requirement and reproduced baseline

The P0 stream capabilities in `flowfn/SPEC.md:352–367` include partitioning, acknowledgement, consumer groups, replay and retention. At baseline `3f95e516ecfe72e93dc9c4bc52a0f26ef26772e4`, the Python Memory provider implemented these partition contracts but Redis did not implement `configure_stream`. The exact baseline archived into an isolated directory rejects public configured `Stream.publish` with `RuntimeError: Adapter does not support stream partitioning` before reaching Redis. No baseline source was modified.

This checkpoint implements Redis partition policy, routing, history, group cursors and attempt receipts through the existing Redis client, shared stream lease helper and versioned routing function. Eight atomic Lua operations use the same bodies as `typescript/src/stream/redis-partitions.ts`. Publication and group initialization also fence legacy policy within new entrypoints. No separate storage runtime, dependency, Redis service deployment or PostgreSQL implementation is introduced.

## Contract

- Immutable counts use `sha256-utf8-u32be-v1`; UTF-8 SHA-256 routing and explicit partition bounds match TypeScript. Stream/group state prevents reinterpretation of legacy history even after trim. Unknown versions and noncanonical counts reject.
- Configured messages use Redis stream IDs and the TypeScript `data`/`headers`/`metadata` field layout. Unconfigured Python payload rows retain their existing format and UUID return behavior.
- One atomic barrier per group/partition holds the message, unique attempt token and Redis-time expiry. Independent consumers can make progress on other partitions. Replacement, renewal, ACK and NACK compare the current token and expiry.
- Active callbacks renew. Returned manual callbacks stop renewal, allowing recovery at the last confirmed deadline. Explicit NACK requeues retained data; unknown publication/claim replies are not blindly retried by the adapter.
- Configured retention deletes payload/history independently of live barriers. Removed payloads cannot renew or be copied into a retry buffer. Cooperative callback cancellation is joined before the local owner attempts release. Lease expiry can still admit another process; arbitrary external effects require application idempotency.
- Public reads return the caller's logical stream name. Cross-language physical identity requires TypeScript prefix `flowfn:<percent-encoded Python namespace>:` and TypeScript stream name equal to `urllib.parse.quote(PythonName, safe='')`. Group names are unchanged. Percent, slash, colon, braces and Unicode cases remain distinct. This mapping does not imply compatibility for legacy payload rows, queues or workflows.
- This uses standalone Redis multi-key operations. Redis Cluster, server-persistence setup, provider deployment and original performance targets are not established.

## Upgrade boundary

Stop old stream writers before enabling configured partition mode. New public entrypoints enforce the immutable policy atomically; old deployed binaries do not read that policy and are not fenced by a host assertion. Existing unversioned rows/groups and legacy policy require an explicit new stream boundary rather than guessed historical routing. There is no automatic in-place migration or repartitioning tool in this checkpoint. Existing legacy streams can continue unchanged.

## Validation receipts

- Exact baseline failure: `/tmp/flow-redis-partitions-baseline.log`.
- Initial six actual Redis cases passed on Python 3.9.6 in 1.47s: public routing, two independent clients, ordered partition delivery/NACK, manual expiry/stale receipts, retention cancellation barrier, encoded identities, and actual TypeScript/Python interoperability with a SIGKILLed TypeScript consumer.
- TypeScript bundle source-map contents for both Redis adapter and partition helper were compared against current source before interoperability acceptance.
- Fresh actual3.9 strict whole-tree mypy exposed three preexisting diagnostics, reproduced identically against the baseline archive. The benchmark now postpones annotations, and two tests call actual asynchronous Redis commands with explicit callable typing rather than ambiguous synchronous/async overloads. No checking rules or dependency versions were relaxed.
- New actual native tests replace the former assertion that Redis partitioning is unsupported. The PostgreSQL fail-closed unsupported assertion remains.

The first native-enabled normal CI reached 182 passed / 68 skipped / 4 failed. All eight partition tests then present passed; the four failures were existing queue/workflow/stream renewal cleanup cases. Running those same cases against the exact unchanged baseline reproduced all four failures (4 PostgreSQL variants skipped), recorded in `/tmp/flow-redis-partitions-baseline-native.log`. Python 3.9 `asyncio.wait_for` could release the outer owner before cancellation-suppressing provider cleanup terminated. A common `wait_for_owned` helper now retains and joins the provider task through repeated cancellation; independent lease timers still expire work on schedule. Normal errors propagate, and late cleanup errors remain chained at the owning coroutine boundary. Three pure helper cases pass, including timeout and repeated cancellation.

A ninth native partition case proves adapter shutdown joins its callback and conditionally releases the current receipt before closing Redis, allowing a replacement without waiting for the five-second lease. The expanded partition suite passes 9/9 in 1.58s (`/tmp/flow-redis-partitions-native-shutdown.log`). The corrected native regression run passed 16 tests with 4 PostgreSQL variants skipped in 6.23s (`/tmp/flow-redis-partitions-native-final.log`), including the four previously failing exact-baseline cases. Normal repository CI on actual Python 3.9.6 passed Ruff, strict mypy over 94 files, package build, and 190 tests with 68 provider/optional skips in 59.34s (`/tmp/flow-redis-partitions-ci-final.log`). Redis was enabled; PostgreSQL was not configured. Existing Pydantic class-config deprecation warnings remain. No failed assertions were removed or made conditional to obtain this result.

Fresh clean-source wheel acceptance passed on Python 3.9.6 and Python 3.11: each independently installed consumer ran all 12 partition/ownership tests and strict mypy over the two consumer files. Runtime import origins pointed into each isolated environment; actual TypeScript/Python Redis interoperability ran in both. The wheel contained the new protocol modules. Receipt: `/tmp/flow-redis-partitions-wheel-final.log`. Consumer directories, private Redis directories, Redis services and Node children were removed/joined; a process inventory found no owned validation processes afterward. The source environment and exact baseline archive remain available until final checkpoint inspection; logs are retained.

Reproduction commands:

```sh
PATH="$task_env/bin:$PATH" python flowfn/.conduct/run-python-redis-ci.py
python flowfn/.conduct/verify-python-redis-partitions.py
```

The first command owns a loopback-only Redis subprocess/private directory and runs the normal repository Python CI script with native Redis enabled. PostgreSQL cases remain skipped. The second builds a clean-source wheel, verifies package members, installs normal development extras into separate Python 3.9/3.11 consumers, checks installed import origin, runs the actual Redis/TypeScript contract suite and strict consumer typing, then removes the consumers.

## Remaining original gates

Python PostgreSQL partition/retention parity, unconfigured Redis pending-payload retention parity, full provider/deployment matrices and original throughput/latency/memory targets remain open. Redis server restart durability depends on its configured persistence. Consumer SIGKILL recovery proves persisted receipts within the owned running Redis service, not Redis server power-loss recovery.
