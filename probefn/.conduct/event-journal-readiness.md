# Durable managed event append checkpoint

This checkpoint addresses EVENT-001 append persistence and SESSION-001 truthful
finalization. It adds a bounded append journal to the existing managed quota
coordinator, with native run ownership throughout admission, file writes and
accounting commits. It does not complete all ProbeFn readiness requirements.

## Behavior

- A committed failure latch precedes admission. The redacted append intent binds
  file identity, exact offset, prefix hash chain, payload digest and rollover
  accounting. Payload plus serialized intent must fit the artifact budget;
  SQLite metadata retains its independent page limit. Coordinator permissions are
  owner-only because intents contain redacted event bodies.
- A new append checks the previously inspected file identity/size/mtime before
  admission. Reopen verifies the complete prefix and every partial suffix byte,
  appends only missing bytes and updates counts. Conflicting or replaced files
  preserve the intent and reject recovery; no unrelated suffix is truncated.
- Recoverable appends restore the prior failure latch. Rejected admission leaves
  a persistent missing-event indication. Completed state/manifest writes check
  that indication inside their storage transaction. Runtime and dev-server stop
  produce failed status, and retain finalized trace receipts, including sessions
  previously marked completed by a trusted caller.
- The additive version-1 coordinator migration preserves caps and existing files.
  Stop all old writers before upgrade; old binaries cannot enforce this protocol.
  A migrated zero latch cannot certify legacy capture completeness.

## Validation receipts

Final checks used Node22.22.0, npm11 and Playwright1.57.0/Chromium143.0.7499.4.

- Full source validation:245 workspace tests across47 files, plus4 admin tests;
  all17 uncached Turbo build/typecheck/test tasks passed in96.5seconds.
  `/tmp/probe-event-journal-full-final.log`.
- Native journal12 cases cover independent process death before append, mid-UTF8
  append, after fsync and before intent commit; live-owner fencing, duplicate-free
  recovery, redaction,0600 coordinator permissions, rollover, earlier failure
  provenance, temporary journal cap, legacy upgrade/future-version denial,
  concurrent external append, changed prefix/suffix and replaced file identity.
- Real resident Chromium tests cover failed finalization from running and previously
  completed state, direct completion denial and preserved trace ZIP receipts.
- Fresh13tarball normal installation passed strict consumer types, CLI/MCP/admin,
  all three independent crash/reopen stages through installed package exports,
  browser checkpoint/action/trace/video and cap behavior. Production dependency
  audit returned zero findings. `/tmp/probe-event-journal-packed.log`.

Commands (from the repository root):

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node /Users/serro/.npm/_npx/fbdd2f0c7d6dfb27/node_modules/turbo/bin/turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin
PATH=/opt/homebrew/opt/node@22/bin:$PATH PROBEFN_PLAYWRIGHT_VERSION=1.57.0 PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js node probefn/scripts/verify-distribution.mjs --browser
```

The installed fixture, source baseline archive, initial failed-test scratch and
all crash children were removed/stopped with terminal readback; raw logs remain.
No Safari settings were changed.

The initial expanded native storage set passed23 tests; loopback stop tests exposed
an early completed-manifest write in dev-server shutdown. The corrected path passed
both terminal-state cases. Adding real resident browser/trace coverage then exposed
completed-state preservation during trace registration; the final source records
failed state while preserving the trace.

The first full run passed243 workspace tests and4 admin tests, with one lifecycle
expectation failure. Exact published baseline
`b384dc65f8648f04ffd0dd9fe4c9ffe0e44b91d4` reproduced that same failure in an isolated
272-file byte-verified source archive with the same dependencies: second stop after
flush failure returns its cleanup receipt, rather than E_SESSION_NOT_FOUND. The
assertion now checks retained ownership, successful cleanup retry and subsequent
absence; first-stop error, browser closure and listener removal remain required.
This source-baseline fixture is not package-install evidence.

Initial/failing logs retained locally:
- `/tmp/probe-event-journal-focused.log`
- `/tmp/probe-event-journal-focused-final.log`
- `/tmp/probe-event-integrity-retry.log`
- `/tmp/probe-event-integrity-final.log`
- `/tmp/probe-event-journal-full.log`
- `/tmp/probe-event-journal-baseline-lifecycle.log`
- `/tmp/probe-event-trace-reproduction.log`

## Remaining boundaries

Only durably admitted managed appends can be replayed. Events still in browser
callbacks, serialization failures before admission, and a coordinator unable to
persist even the failure latch are outside this journal's recovery guarantee.
Callers must propagate those failures. A repeated caller submission is a new event;
this is interrupted-append recovery, not application request deduplication.

Evidence targets independent process SIGKILL/reopen on local SQLite, not physical
power-loss certification, hostile simultaneous filesystem mutation or network
filesystem durability. Irrecoverable conflicts intentionally block completion and
need operator investigation. Opaque Playwright scratch, total physical filesystem
quota and orphaned encoder scratch reclamation remain open. No provider deployment,
external site capture or release is part of this checkpoint.
