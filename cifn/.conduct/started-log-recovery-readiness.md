# Read-only recovery of started runner logs

## Requirement and behavior

RUNNER-005 requires step logs through LogFn and persisted run state. The original API specification permits streamed or JSON log retrieval; phase 10 classifies real-time dashboard streaming as optional. This checkpoint closes the persisted-log recovery gap after a runner dies while its journal is still `started`, without redefining optional dashboard streaming as mandatory.

Each runner tick can read one immutable spool snapshot for an owned started journal and replay its unacknowledged nonterminal packets through the existing authenticated claim-log endpoint. Identity, packet sequence, digest, counters and size bounds are checked before any request. The file is opened read-only, without following a final-component symlink, and must be a regular file. Both stat and the actual read enforce a 3 MiB serialized bound; existing 1 MiB event payload and 4096 event bounds still apply. Invalid/incomplete checkpoints emit only a generic recovery diagnostic.

Recovery never creates, rewrites, acknowledges, seals or physically expires the spool. A concurrently active owner may append or persist acknowledgements; the snapshot cannot overwrite them. The receiver's existing sequence/digest deduplication makes retries safe. An acknowledgement beyond the snapshot is valid when another owner advanced the receiver. A terminal packet is deliberately withheld because log recovery cannot establish execution completion. Expired snapshots send nothing. No credentials from a malformed snapshot are used: all five identity fields must match the journal before sending.

The execution journal remains `started`, the run remains uncertain/running and log transfer remains pending. No shell command is restarted and no successful execution result is fabricated. This does not implement active execution-owner reconciliation, external LogFn forwarding, remote non-shell providers, a fixed live-log latency SLA or complete production readiness. Local cleanup of expired payloads still requires the writable owner/reconciliation path; this reader must not delete another owner's files. Per-request timeout remains ten seconds; this change does not add a whole-tick deadline across all bounded packets/journal entries. The filesystem boundary assumes a host-owned private state directory, not isolation from a hostile same-user process.

## Validation (2026-10-23)

- Full runner suite: 109 tests across six files pass, single worker. Includes actual shell lifecycle and TestFn executions; expected inner failing-test output is asserted by the outer passing tests.
- Source TypeScript check, strict remote TypeScript check and runner build pass.
- Snapshot tests interleave an awaiting replay ACK with real owner appends/ACK writes and assert byte-for-byte and mtime preservation. Reopen sends only the owner's remaining terminal packet. Missing/expired/sealed, malformed identity/digest/sequence/counters, incomplete JSON and oversized files are covered.
- Built HTTP/SQLite acceptance uses real shell stdout/stderr, blocks log delivery, waits for persisted redacted packets, kills the owned runner process, releases and observes exit of its owned shell, reopens the control-plane database, and ticks recovery twice. Both lines appear once, spool bytes remain unchanged, the shell witness remains once and journal/run/transfer uncertainty remains explicit. Existing live-before-completion, lost ACK, log-only outage and secret-absence assertions still pass.
- Fresh normal production install of 11 local tarballs using Node 22.22.0/npm 11: installed paths are verified inside the consumer's `node_modules`; CJS and ESM imports plus the same native HTTP/SQLite acceptance pass. Production audit reports zero vulnerabilities. Source native execution used Node 20.20.0 with its existing SQLite ABI. No dependency or root-lock changes.

Reproduce after building the existing package closure:

```sh
npm --workspace=cifn/typescript/runner test -- --maxWorkers=1
npm --workspace=cifn/typescript/runner run lint
./node_modules/.bin/tsc -p cifn/typescript/runner/tsconfig.remote.json
npm --workspace=cifn/typescript/runner run build
node cifn/typescript/control-plane/scripts/verify-remote-logs.mjs
# Select a supported Node and optionally a matching npm CLI via CIFN_NPM_CLI.
node cifn/typescript/control-plane/scripts/verify-packed-logs.mjs
```

Local receipts: `/tmp/cifn-started-log-{focused,full,types,remote-types,build,native,packed}.log`. Native receipt reports `killedRunnerLogRecovery`, `startedExecutionStillUncertain` and `readonlyReplay` true. Installed receipt reports 11 packages, both module formats and audit zero. Native children, servers and private temporary state were closed/removed; the packed consumer was removed. No external provider calls, deployments or publication were performed by these fixtures.
