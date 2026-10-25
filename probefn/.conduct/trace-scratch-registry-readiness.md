# Durable trace scratch ownership

Baseline: bd5209886c1618bcc6224cbb64909d0b7a509675. Date: 2026-10-25.

## Requirement and scope

STORAGE-002 requires configurable artifact/event caps and explicit failure or
rollover; OBS-001 requires real trace artifacts linked from reports. This slice
implements durable ownership and conservative cleanup of the explicit trace ZIP
finalization directory. It does not impose a kernel filesystem quota or cover
opaque Playwright profiles, browser caches, or video encoders. The broader work in
[physical scratch next steps](physical-scratch-next-steps.md) remains required.

## Protocol

The existing SQLite accounting coordinator now carries version 1 of the capture
scratch registry. Each record reserves 4 KiB against the existing run byte cap;
SQLite's existing page cap additionally bounds the registry database. Records
have a fixed 4 KiB serialization bound and recovery pages are limited to 100.
Scratch files live in a reserved directory inside their owning run and are counted
by the existing run scanner. This accounting is not a hard bound on bytes produced
by Playwright before its finalization call returns.

Native run ownership spans the producer operation, but individual SQLite write
transactions remain short. Directory identity, a private ownership marker,
producer state, sealed file digest and destination are durable and run-scoped.
Only relative paths are persisted. A generation is committed before directory
creation; the producing state is committed before giving its path to Playwright.
The awaited local ZIP export (or remote saveAs and final ZIP append) in installed
Playwright 1.57.0 `lib/client/tracing.js` supplies the completion boundary for the
specific trace output. A failed export does not establish quiescence.

Recovery behavior:

- Prepared and verified directories were never given to a producer and may be
  removed. A directory created before its identity commit is retained if identity
  cannot be established.
- Producing generations become quarantined. Age, PID disappearance and release of
  the native run lock do not authorize deletion.
- Sealed generations retain their trace when admission did not complete. If an
  exact destination digest already exists, recovery recognizes the completed
  import and records admission without rewriting that destination.
- Admitted generations are removed only after checking the destination receipt,
  scratch identity and source bytes. Changed user files are never rewritten or
  deleted. Missing source/marker files in an already committed removal phase can
  be finished; unrelated directory entries or changed identity stop cleanup.
- Cleanup retains a `cleaned` receipt after removing scratch. A process death before
  session publication therefore leaves the destination/digest available on recovery.
  The host acknowledges only after durable session persistence; the MCP runtime
  performs this acknowledgement after its session update. Changed destinations fail
  closed and repeated acknowledgement is harmless. Destination lookup materializes
  at most two records and rejects ambiguous duplicate destinations; it may scan the
  run registry (no indexed query-work bound is claimed).
- An explicit live import failure can discard a sealed, quiescent source while
  reporting the failure. That is distinct from unknown producer completion.

`ArtifactStore.reconcileTraceScratch(runId, id)` is the explicit admission path
for sealed output. It verifies source identity/digest, uses exclusive destination
creation, persists the destination inode, and resumes only an exact matching prefix
of that inode. It appends missing bytes under the existing cap and commits admission
only after file/directory synchronization and full destination verification. An
existing unrelated destination or changed prefix is retained unchanged. A crash
between exclusive creation and destination-identity commit remains an explicit
conflict: the source and ambiguous destination are retained, not guessed owned.
The host links the returned relative path into its session/report using its normal
session persistence flow; automatic recovery itself does not invent a session
receipt. This still leaves that ambiguous creation boundary and unknown-producer
quarantines requiring explicit host reconciliation.

Recovery returns bounded records with removal/error status and a keyset cursor.
It does not fabricate an admitted receipt for sealed-but-unimported output. Failed
or unknown captures remain explicit; automatic recovery does not silently truncate
them. A quarantined live session can remain cleanup-pending after browser close;
restarting the coordinator does not authorize deleting that quarantine.

## Upgrade boundary

Stop all older Probe writers before first use of this registry protocol. The
additive versioned schema is created through the existing storage initialization
path, and unsupported future versions fail closed. Older binaries do not enforce
reserved scratch paths or this state machine; mixed writers are unsupported. This
operator barrier is not distributed fencing of old processes. Existing global
`probefn-*`/Playwright temporary directories are not adopted or swept.

## Validation

Initial focused acceptance passed 20 tests: eight storage/native cases, ten real
browser cleanup cases and two artifact-cap cases. The next twelve-case native
pass added independent SIGKILL during admission copying and after file fsync,
verified exact prefix resume, and denied changed prefixes/destinations.
Logs: `/tmp/probe-scratch-registry-focused-rerun.log` and
`/tmp/probe-scratch-reconcile-focused.log`. The first attempted run caught a guard
that rejected the configured `.artifacts` prefix; the correction validates only
the run-relative destination. Failed output is retained separately in
`/tmp/probe-scratch-registry-focused.log`.

Expanded focused acceptance passed 31 tests (19 storage/native, ten browser cleanup,
two artifact-cap), followed by green source types. The final source adds two more
native cases for cleanup-complete crash receipt replay and changed-destination
acknowledgement denial. Logs: `/tmp/probe-scratch-registry-expanded.log`,
`/tmp/probe-scratch-registry-receipt-focused.log` and
`/tmp/probe-scratch-registry-final-types.log`.

The first full wave built/typechecked successfully (16 of 17 tasks) but had 240
workspace passes, five failures and 27 setup-dependent skips, plus four admin
passes. Persisted fixture ownership records had device 16777243 while the current
mount reports 16777245 for the same inode. The baseline bd520 selected trace test
also failed before browser startup; exact baseline tracked source was temporarily
materialized, tested, then restored with byte verification. Logs:
`/tmp/probe-scratch-registry-full.log` and
`/tmp/probe-scratch-baseline-lock-failure.log`. Existing coordinator and run_hmr
intent evidence are preserved. Fresh isolated fixture-root validation follows;
production ownership checks were not weakened.

The old ten-byte trace fixture could no longer reserve registry metadata. Its
updated case explicitly budgets 10000 bytes, rejects a 10001-byte export, admits
1000 bytes, acknowledges publication and rejects a further 9001-byte write.
The separate pre-admission test rejects a 4095-byte budget before producer entry.

The first isolated harness omitted Probe-local dependencies and used the parent
working directory: 227 tests passed, ten files failed collection and one native
child could not locate its dist entry. Correcting dependencies/cwd produced 47
passes and two MCP child failures because symlinked dist paths did not satisfy the
CLI direct-invocation guard. Built outputs were then copied as identical files;
no CLI behavior or test assertion changed. These setup failures are retained in
`/tmp/probe-scratch-registry-isolated-full.log` and
`/tmp/probe-scratch-registry-isolated-harness-rerun.log`. The isolated source copy
manifest is `/tmp/probe-registry-full-copy.json`.

Final validation used Node 22.22.0 and ordinary npm 11 installation:

- Original full Vitest workload in the corrected isolated source root: 48 files,
  273 tests passed in 97.18 seconds, including 22 registry/native/migration tests.
  `/tmp/probe-scratch-registry-isolated-full-final.log`.
- Final Turbo `build typecheck --filter=@probefn/workspace --filter=@probefn/admin`:
  all 15 tasks passed; final workspace types also passed after the migration case.
  `/tmp/probe-scratch-registry-final-build.log` and
  `/tmp/probe-scratch-registry-final-types.log`. Four admin tests passed in the
  original full wave; no admin source changed.
- Fresh 13-tarball consumer passed CLI/MCP/admin imports, strict TypeScript,
  three event-journal SIGKILL stages, six trace-scratch SIGKILL stages including
  cleanup-before-publication, and real Chromium 143.0.7499.4 acceptance. Browser
  evidence included a 165438-byte trace with actions, a 6645-byte streamed WebM,
  cap/rollover/owner fencing and joined dev-server shutdown.
- **The installed command exited 1 at its unchanged final production audit gate.**
  The report contained 15 affected package entries propagated from Zod (high,
  GHSA-mrhx-c7xc-m3w5) and fast-uri (four moderate/low advisories). No audit threshold
  was relaxed and no dependency upgrade is included in this scoped checkpoint.
  Runtime/browser/type success is distinct from this unresolved dependency gate.
  `/tmp/probe-scratch-registry-packed.log`; extracted report
  `/tmp/probe-scratch-registry-audit.json`.

Commands were the existing Turbo closure above, `npm run typecheck
--workspace=@probefn/workspace`, the original `vitest run` in the isolated Probe
root, and `PROBEFN_PLAYWRIGHT_VERSION=1.57.0` with
`node probefn/scripts/verify-distribution.mjs --browser` using the normal npm 11 CLI.
The owned isolated source directory and installed consumer were removed, with
readback; logs and the source-copy hash manifest remain. No owned browser, native
child, dev-server or test process remains. No operating-system disk,
mount, quota, browser setting or external service is changed by this checkpoint.
