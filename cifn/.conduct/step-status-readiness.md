# Durable remote step transitions

This checkpoint addresses RUNNER-005 from the original `specs/2026-02-05-new-c8f2n1xq-spec/REQUIREMENTS.md:323`: report step/job status and persist run/job/step state. The 2026-02-07 audit uses the same ID for a different requirement. This does not claim full CiFn readiness or automatic reconciliation of unknown executions.

## Behavior and boundaries

The actual Runner transition path now has an optional awaited `onStepStatus(stepKey, status)` observer. Running, success/failure, skipped and condition-failure paths use it; errors cannot be swallowed as a condition failure and invent an additional terminal event. Remote shell execution supplies a durable observer. Local callers without an observer retain their existing behavior.

A mode0600 atomic fsynced sidecar under mode0700 `steps/` records only the claim identity and canonical sequence/step key/status/digest. It contains no job environment, script or secret snapshot. Maximum200 events follows the original100-step job limit; the serialized file is bounded to128KiB including identity. Reads validate the actual byte count, regular-file type, exact identity, record shape/sequence and digests before authenticated transport. The final file is opened without following a symlink. One execution owner is fenced by the existing exclusive started marker. Read-only replay never writes acknowledgements over concurrent appends or changes a claim result.

The new `/api/v1/runners/claims/step` operation uses existing runner authentication and schema-wrapped encrypted run CAS. It accepts only the bound execution, known steps in sequence, and monotonic state transitions. Exact duplicates are idempotent even after cancellation/completion; new events after those terminal states reject. Contradictory terminal step results make job completion reject instead of overwriting established state. Timestamps represent control-plane acceptance, and existing terminal step timestamps survive whole-job completion.

Transport failures retain the journal and allow execution to proceed; local persistence failures or explicit client/protocol conflicts stop subsequent execution with uncertainty retained. Job completion waits for status replay. During cancellation, late events remain locally retained but cannot resurrect a run; cancellation acknowledgement remains separate from these events. A running event precedes the subprocess attempt and is not evidence that a process remains alive. Unexpected execution exceptions preserve uncertainty when durable observation is enabled rather than replacing previously accepted terminal steps with a fabricated aggregate failure.

The sidecar is bounded per claim, not globally across retained runner history. No new automatic deletion/retention or physical power-loss certification is claimed. Host-owned private filesystem assumptions remain; this is not isolation from a hostile same-user writer. Deploy the updated control plane before updated runners, and drain old writers before relying on intermediate-status guarantees. Legacy aggregate completions remain compatible; protocol availability is not silently inferred when an old server rejects the endpoint.

The Python package is an HTTP SDK, with existing StepStatus and Run/Step parsing; no Python executor exists to mirror. The remote executor still explicitly rejects unsupported non-shell/container providers. Full original LogFn integration, active execution-owner reconciliation and other readiness gates remain open. API-006's JSON-or-stream choice does not waive the original named LogFn requirement.

## Validation

- Node20.20.0 source:119 runner tests across7 files and191 control-plane tests across13 files pass. A subsequent focused regression also passes: completed execution retained during a step transport outage reopens and delivers without a second shell invocation. Source and strict remote/durable TypeScript checks plus both package builds pass.
- Journal tests cover persistence-before-transport, admission failure before shell launch, immutable replay interleaved with owner append, exact private file mode, invalid identity/sequence/digest/JSON/size rejection, finite event bound and invalid acknowledgements. Transition tests cover success, condition failure, skip, failure-dependent flow and observer rejection without fabricated failure.
- Native SQLite tests cover actual authenticated HTTP requests, failure-before-commit503 with unchanged state, duplicate delivery through independent connections, close/reopen, out-of-order/unknown execution rejection, conflicting terminal outcomes, timestamp preservation and cancelled-run behavior.
- `verify-step-status.mjs` holds a real second shell after a first shell finishes. HTTP reports `[success,running]` before release and `[success,success]` afterward. A response lost after committing the first terminal event causes stable idempotent replay.
- `verify-remote-logs.mjs` now also blocks step delivery before killing the runner, observes private persisted running state, releases and observes exit of the owned shell, reopens SQLite and replays twice. The API changes pending→running, the journal bytes remain unchanged, and job/run remain uncertain/running without a second execution or fabricated terminal result.
- Fresh11-tarball normal production installation on Node22.22.0/npm11 passes canonical installed-path checks, CJS/ESM imports and both native fixtures. Production audit reports zero vulnerabilities. Strict installed declaration acceptance is recorded by the final consumer receipt.

Commands:

```sh
npm --workspace=@cifn/runner test -- --maxWorkers=1
npm --workspace=@cifn/control-plane test -- --maxWorkers=1
npm --workspace=@cifn/runner run lint
./node_modules/.bin/tsc -p cifn/typescript/runner/tsconfig.remote.json
./node_modules/.bin/tsc -p cifn/typescript/control-plane/tsconfig.durable.json
npm --workspace=@cifn/control-plane run build
npm --workspace=@cifn/runner run build
node cifn/typescript/control-plane/scripts/verify-step-status.mjs
node cifn/typescript/control-plane/scripts/verify-remote-logs.mjs
# Supported Node with matching native SQLite ABI; optional explicit CIFN_NPM_CLI.
node cifn/typescript/control-plane/scripts/verify-packed-logs.mjs
```

Receipts are under `/tmp/cifn-steps-*.log`. Initial focused failures were fixture compatibility: legacy fake HTTP transports had no step acknowledgement, and `false` is not a supported condition expression. Fixtures now implement the step contract and use the existing supported `failure()` expression for skip behavior. Original failure receipts are retained; no production gate or timeout was weakened.

Final receipts: `/tmp/cifn-steps-runner-full.log`, `/tmp/cifn-steps-control-full.log`, `/tmp/cifn-steps-completed-replay.log`, `/tmp/cifn-steps-remote-types-final.log`, and `/tmp/cifn-steps-packed-final.log`. The final packed receipt reports `strictDeclarations: true`, 11 installed packages, CJS/ESM success and production audit zero. Owned fixture servers, shell processes and temporary consumer directories were cleaned; all validation commands exited.
