# Durable run artifact accounting

The original specification requires a default 2 GiB artifact volume per run and
50,000 events per sink, with structured failure or explicit rollover. The prior
store-local cumulative counter reset when a store was reopened and did not admit
external browser traces or visual diffs through the cap.

## Implemented behavior

`ArtifactStore` now serializes all cooperating run writers with SQLite
`BEGIN IMMEDIATE`, plus a process-local queue so asynchronous streaming operations
never interleave on one connection. Persisted caps cannot be raised by reopening
a default store. Actual retained file sizes determine usage, including existing
files and registered session-state. Run manifests, reports, checkpoints, event
logs, screenshot/video/trace imports and visual diff output use this path.

Atomic replacements charge the old file and new staging bytes until rename.
Failed writes clean their staging files; successful deletion reclaims actual
volume. This intentionally replaces cumulative attempted-write accounting with
retained-volume accounting. Lowering a cap preserves existing evidence and blocks
new writes until explicit deletion makes room. Session-state paths require an
explicit run scope and cannot be reassigned to another run.

A crashed process releases its SQLite OS lock. The next writer reconciles the
filesystem and removes abandoned controlled staging output under that lock.
There is no PID-based lock stealing. Event counts persist across independent
instances and are reconstructed from native files when cached identity, size or
mtime differs. Partial records fail closed without silent truncation. Path escape,
symlink, hardlink and special-file destinations are rejected.

The runtime floor is Node.js 22.13.0. The built-in `node:sqlite` API is available
without an experimental flag at that version; it still emits an experimental
warning. The implementation uses `DatabaseSync`, `exec`, `prepare`, `get`, `run`
and `close`, checked against the [Node 22.13 documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)
and an actual 22.13.0 runtime. No new external native dependency was added.
Visual baselines now depend on the existing `@probefn/storage` workspace package.

## Acceptance evidence

- Exact Node 22.13.0: 14 final storage/browser tests passed, including native filesystem quota
  behavior, five rounds of four independently spawned competing writers, a
  SIGKILL during an active streaming transaction followed by reopen, session-state
  bypass attempts, repository-root artifact paths, and real Chromium screenshot,
  video and trace admission/rejection. Browser pages use owned local fixtures or
  `setContent`; no public sites are involved.
- Node 22.13.0 also passed all five visual baseline tests, including persisted
  visual-diff rejection, in the focused integration run.
- Node 22.23.3: all 177 tests across 35 files passed. TypeScript project
  typecheck and `git diff --check` passed.
- Existing 200-line stderr startup-failure coverage exposed a timing race after
  durable fsync: process exit now cancels readiness timeout immediately while still
  awaiting complete log drain before returning the exit error.
- Local fixture servers use assigned ports where fixed ports conflicted with
  unrelated processes, and publish the actual bound port. The native MCP flow
  integration has an explicit 15-second test budget for browser work and durable
  fsync. Baseline fixture session
  IDs are distinct from action fixture IDs to preserve durable ownership.

Local logs: `/tmp/probe-quota-final-focused.log`,
`/tmp/probe-quota-final-full.log`, `/tmp/probe-quota-final-minimum.log`, and
`/tmp/probe-quota-minimum-node.log`.

## Remaining original gate

This checkpoint bounds admitted run artifact payload, not total physical storage.
SQLite coordinator/journal bytes, filesystem allocation overhead and opaque
Playwright scratch remain outside the payload cap. Imported traces are streamed
through admission and owned scratch is removed on normal success/failure, but a
killed host/browser can leave opaque scratch. OS-enforced scratch quotas and crash
reclamation remain required for a total-run physical disk bound.

SQLite coordination assumes cooperating writers on an application-owned local
filesystem with functioning OS file locks. It is not hostile-process isolation.
Direct low-level sink/counter utilities and generic non-run writes retain legacy
local semantics. Shared auth profiles and baseline registry storage are explicitly
outside per-run accounting. No deployment, publication or production acceptance
is established by these local tests.
