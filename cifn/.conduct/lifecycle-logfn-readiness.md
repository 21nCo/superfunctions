# Control-plane LogFn lifecycle checkpoint

Original 2026-02-05 REQUIREMENTS RUNNER-005:325 and INT-004:423 require step output and run/job events through LogFn. OBS-001:494 also names runner registration/heartbeat and API/parse errors. The remote output spool already invokes actual `@logfn/core`; its private durable sink does not establish configurable external forwarding. The prior control-plane real adapter rejected a fictional LogFn HTTP server API, and only run.created was sent through the memory adapter.

This slice adds run-scoped encrypted lifecycle records inside the existing state CAS. Run creation and actual before/after run/job/step changes persist atomically; no transaction spans sink I/O. Fixed event fields exclude scripts, environments, pipeline metadata and raw errors. Known secret values are masked in job/step keys before retention. Stable event IDs survive reopen and pruning. No old history is fabricated on upgrade.

Actual LogFn delivery is available through `LogFnLifecycleDispatcher` with a real host-owned sink, or the built server's explicit SQLite-only `CIFN_LIFECYCLE_LOGS=console`. The CJS build bundles the ESM-only logger as the runner already does. Durable log query storage remains separate and authoritative. Existing unsupported standalone HTTP adapter configurations still fail closed.

Each tick reads a keyset page of at most 10 run rows, one event per run. CAS claims fence concurrent dispatchers. Sink/flush errors and expired claims park unknown, blocking later events for that run. No automatic replay of ambiguous external effects occurs. Operator reconciliation is explicit and can authorize retry with duplication risk. Receipt success describes the sink's contract, not an invented downstream durability guarantee. Close stops admission and joins active work; arbitrary callbacks require their own finite I/O contract and have no hard cancellation guarantee.

Retention is explicit delivered-only pruning, at most 100 records per operation. Unresolved records are pinned. Per-run admission is capped at 25,000 retained events and 8 MiB serialized ledger plus reserved claim/receipt metadata; capacity failure rejects the state transition atomically, while receipt/pruning operations remain available. There is no silent TTL deletion. Global run history/database disk remains unbounded by this per-run rule. The existing encrypted run-row layout means each mutation decodes/re-encodes the run payload; no indexed global pending-event projection is claimed. Polling scans bounded indexed run pages and hosts must traverse cursors for fairness.

Older writers must be drained: they preserve unknown payload fields but do not generate these events. No automatic namespace migration or retroactive event inference occurs. Remaining original requirements include runner registration/heartbeat and API/parse error durable telemetry, configurable external forwarding of step output, and safe execution reconciliation. This is not full CiFn readiness.

Initial focused native proof: `/tmp/cifn-lifecycle-native-focused.log` (3 passed, 123 ms), including independent SQLite dispatchers, close/reopen, atomic failed-state update, expired ownership, ambiguity parking and retained unresolved history.


## Final validation

- Node20.20.0 full control-plane suite: 199 tests in14 files pass (`/tmp/cifn-lifecycle-control-full.log`). Strict durable/observability types and CJS/ESM/declarations build pass (`/tmp/cifn-lifecycle-types-final.log`, `/tmp/cifn-lifecycle-build.log`).
- SQLite cases prove close/reopen, independent dispatchers with exactly four unique deliveries, state-write failure with no event, expired ownership parking, unresolved retention, explicit retry, concurrent state change while shutdown joins a held sink, and monotonic sequence after pruning.
- Pure contracts cover metadata exclusion and known-secret key masking, terminal child/parent order, capacity admission while allowing maintenance, sync/async/flush failures, oversized/truncated envelope rejection before sink invocation and awaited asynchronous completion.
- `/tmp/cifn-lifecycle-native-final2.log`: built public API, native SQLite, child killed after durable claim, reopened unknown parking, actual LogFn pipeline to owned loopback HTTP, accepted-then-error preserved unknown without blind replay.
- `/tmp/cifn-lifecycle-server.log`: real built server with explicit console mode emits a structured LogFn run.created event matching the actual run ID, alongside real gated shell/status/lost-ACK acceptance.
- `/tmp/cifn-lifecycle-packed-final.log`: fresh normal11-tarball npm11 production consumer on Node22.22.0, canonical installed paths (including direct @logfn/core), CJS/ESM imports, strict declarations, all three native fixtures and production audit zero. No production manifest workaround or native ABI forcing.

Initial fixture failures are retained in `/tmp/cifn-lifecycle-native.log`, `/tmp/cifn-lifecycle-native-final.log` and `/tmp/cifn-lifecycle-packed.log`: the fixture first assumed a private runtime factory was exported, then attempted require of the shared DB adapter's ESM/top-level-await graph. The corrected fixture uses public DatabaseStore/schema APIs and dynamic import of the shared adapter. No product export or test requirement was weakened to accommodate those assumptions.

All validation commands exited. Owned loopback listeners, child processes, private SQLite directories and fresh consumer directories were cleaned. No external provider was contacted. The step-status checkpoint remains separate at3cd3189772c33c38b600ca82a747dfec72d411d6.
