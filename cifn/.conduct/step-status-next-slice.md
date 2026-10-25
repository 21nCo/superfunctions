# Required remote step-status follow-up

Implemented by the later [durable remote step transition checkpoint](step-status-readiness.md). The historical baseline below is preserved; its standalone helper now delegates to actual acceptance of `[success,running]` while the second shell is active.

## Reproduced baseline

At source checkpoint `c307a7643e603677d8efea5bb693f6cdc875a60b`, a real two-step remote shell job completes step 0 and holds step 1 on an owned filesystem gate. The control-plane HTTP API reports the run/job as running but both steps as pending. Releasing the gate completes the job and updates both steps to success together.

`node cifn/.conduct/scripts/reproduce-step-status-gap.mjs` is a standalone diagnostic, deliberately absent from CI scripts. It asserts this known baseline gap; a future fix should update or retire it rather than preserve pending statuses. It uses built packages, native SQLite and owned loopback HTTP/shell processes, with a ten-second safety exit on the gated shell, bounded 60-second execution/cleanup waits to allow existing HTTP deadlines, and owned control TERM/KILL escalation. Timeout retains the private directory because it does not prove shell termination. No product code changes are included.

Observed 2026-10-23 on Node20.20.0, initial receipt `/tmp/cifn-step-status-gap.log`; the bounded-cleanup helper rerun also passed in `/tmp/cifn-step-status-gap-final.log`:

```json
{"baselineGapReproduced":true,"whileSecondShellActive":{"run":"running","job":"running","steps":["pending","pending"]},"actualWitnesses":["first finished","second running"],"afterRelease":{"run":"success","steps":["success","success"]},"node":"v20.20.0"}
```

The runner tick completed, the control process exited and the private temporary directory was removed. No external calls or settings changes occurred. This is source-built native evidence, not another installed-package acceptance run.

## Requirement and source anchors

- Original `specs/2026-02-05-new-c8f2n1xq-spec/REQUIREMENTS.md:323` RUNNER-005 requires reporting step/job status and persisting run/job/step state; its acceptance says status updates after a step runs.
- `REQUIREMENTS.md:145` API-004 requires full run details, including jobs/steps. `REQUIREMENTS.md:213` RUN-001 prohibits terminal run regression.
- `typescript/runner/src/remote-runner.ts:19` constructs scratch MemoryStore state. Lines32–37 project terminal steps only after the entire Runner call finishes.
- `typescript/runner/src/runner.ts:204` executes step transitions by directly mutating scratch job/step objects; the shell path begins its running transition at line510. There is no durable remote transition observer.
- `typescript/control-plane/src/store/database-store.ts:397` writes every terminal step together during completeDispatch.
- `typescript/runner/src/remote-runner.ts:101` deliberately refuses replay for a started journal. Its started witness is not an authoritative process-exit receipt.

The requirement ID above belongs specifically to the original 2026-02-05 specification. The later 2026-02-07 audit specification reuses RUNNER-005 for secret redaction; that is a different requirement. This pending status protocol is separate from the completed read-only started-log recovery checkpoint.

## Proposed implementation, not yet implemented

1. Introduce an awaited optional Runner status observer at actual transitions, including skipped/condition-failure paths. Preserve existing local behavior when absent. Persist each event before attempting transport; avoid deriving states from log strings or periodically sampling mutable state.
2. Use a bounded private claim-bound step-event journal, separate from log bytes. A maximum of two transitions per configured step (at most100 steps) gives a small finite record bound; include explicit byte validation, schema/version and exact execution identity. Preserve events across lost acknowledgements and crash. Freeze accepted event data before async operations.
3. Add an authenticated control-plane claim operation backed by the existing schema-wrapped store CAS. Validate execution ownership, known step/order, sequence/digest and monotonic transitions. Exact replay must be idempotent; conflicting terminal outcomes must reject. completeDispatch must reject conflict with an already persisted terminal step, while preserving existing terminal run and cancellation rules.
4. Replay pending status events without claiming execution ownership or rerunning commands. A missing result remains unknown; a terminal step does not itself imply a terminal job. Define cancelled-run behavior explicitly, so delayed receipts neither resurrect the run nor fabricate later step execution.
5. Native acceptance should cover the gated two-step case, condition/skipped/failure paths, lost ACK, SQLite reopen, independent concurrent replay, killed runner and authenticated conflict rejection. Fresh installed consumer evidence must exercise the same public runner/control-plane flow.

Automatic reconciliation of an unknown shell result requires a separate durable execution supervisor/exit receipt and careful ownership semantics. Neither a stale heartbeat nor a `.started` marker is proof of termination. This plan does not authorize killing or replaying uncertain shells, adding new run states, or declaring unknown work successful/failed. Real-time dashboard streaming is explicitly optional in phase10; API-006 permits streamed or JSON logs. The original RUNNER-005 explicitly requires reporting logs to LogFn and names that integration. API-006 controls JSON versus streaming delivery; it does not waive the named LogFn integration. Whether the current bounded local durable-log path fulfills that integration remains an open original requirement.
