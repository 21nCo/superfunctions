# Managed SDK writer ownership

This checkpoint extends the resident CLI/MCP authority to direct `ArtifactStore` mutations. The admission boundary is the existing `RunQuota.transaction`: run writes, streamed writes, completed-file imports, deletes, manifests/reports, policy initialization, externally accounted session state, and `ArtifactStore.createEventSink` persisted appends all pass through it. No second native lock protocol is introduced.

## Ordering, authority and failures

Within one process the existing accounting queue serializes independent operations. Each queued operation then acquires the native run slot before entering the quota SQLite transaction. Session-state JSON mutations acquire both run and session slots in the same deterministic sorted order as runtime owners; changing the claimed run cannot bypass a live session owner. Raw admission retries only lock acquisition, for one monotonic second, then returns `E_SESSION_ALREADY_RUNNING`. No producer or filesystem side effect is retried. The existing separate 30-second quota database busy bound remains. Queue time and caller-supplied producer execution are not included in the one-second admission bound.

Runtime operations, asynchronous producer callbacks and cleanup explicitly enter `SessionOwnership.run`. Matching authority is reused after inode/liveness checks, while a released or different run/session/root context fails. Runtime cleanup fallback after missing session state also enters that context; otherwise it would contend with its own retained native lock. A stream producer awaiting another managed quota transaction fails before queueing rather than deadlocking behind itself. Failure removes staged files, releases ephemeral authority, and leaves independent queued writes usable.

The existing canonical authority directory, volume-dependent case folding, stable registered lock inodes and killed-process recovery remain. Managed directory casing must match configured paths. On case-insensitive volumes existing run/session filename casing must match the persisted identity, preventing separate quota keys for the same files. Unscoped ArtifactStore writes reject symlink ancestors, and reserved ownership/accounting/staging paths are rejected including case variants. This is cooperative API fencing, not a security boundary against arbitrary external filesystem mutation.

Run-only SDK admission uses the existing metadata budget: default 256 lifetime slots, configurable `maxOwnershipSlots` up to 65536. Reopening an existing run does not allocate a new slot. Exhaustion is explicit; no active lock files are deleted or recycled. No OS-wide disk quota is claimed.

## Runtime producer audit and exact API boundary

- `ArtifactStore.writeManaged`, deletion, policy initialization and persisted event hooks call `RunQuota.transaction`.
- `SessionManager` writes session-state through `ArtifactStore.writeArtifact` with an explicit run scope.
- `AuthProfileStore.initializeSessionStorageFromProfile` previously copied directly into `runs/<id>/session-storage`; it now uses capped `ArtifactStore.importArtifactFile`. `writeSessionStorageState` now uses managed `writeArtifact`. Both have native ownership and cap regressions.
- Runtime constructs `NdjsonEventSink` only in `ArtifactStore.createEventSink`, with the persisted quota hook. No runtime package directly constructs an unscoped sink.
- Browser traces import finalized scratch files through ArtifactStore. Video finalization returns bytes for the managed checkpoint writer. Opaque browser scratch is still outside the run artifact cap.
- Remaining direct auth-profile file writes/copies target non-run `auth-profiles`, and visual-baseline copies/atomic registry writes target the configured baseline root. They do not become globally serialized by this run protocol. Callers must configure those roots as separate non-run storage.
- Exported generic `writeAtomicFile`, `writeJsonManifestAtomic`, and standalone `NdjsonEventSink` have arbitrary-filesystem contracts, not an artifact-root/run contract. They remain unscoped, like direct `fs` calls. Do not use them to mutate managed run/session destinations; use ArtifactStore. No artifact-root inference or comprehensive filesystem isolation is promised.

## Validation

Initial focused validation passed 23 storage/quota/accounting/resident tests plus two actual native-process MCP/raw-writer tests. The latter launch the built MCP stdio server and a distinct Node ArtifactStore writer. The writer is rejected while MCP owns the run and leaves no target file; it succeeds after normal stop and after a real `SIGKILL`/PID disappearance. The killed session remains `running` on disk: lock recovery does not pretend interrupted work completed.

The full Turbo build/typecheck/test command passed 215 integration tests across 43 files and four admin tests, all 17 tasks (81.201 seconds, `/tmp/probe-writer-full1.log`). This includes native independent-process cap serialization, pager pressure/rollback, killed quota owner recovery, session-slot spoofing, auth-session cap/import/write checks, aliases, and missing-session-state cleanup.

After the final nested-transaction guard, all 15 build/typecheck tasks passed (`/tmp/probe-writer-final-types.log`), and all four managed-writer regressions passed (`/tmp/probe-writer-final-focused.log`, 5.44 seconds). The nested producer left neither inner nor outer committed file, staging was empty, and two independent subsequent writers succeeded. Existing test deadlines were not relaxed. The full suite predates only this final guard; installed results follow below.

The fresh normal 13-tarball consumer also passed after the final guard (`/tmp/probe-writer-installed.log`). Node 22.22.0/npm 11.21.0, Playwright 1.57.0 and cached Chromium 143.0.7499.4 were used. Actual installed npm bin/MCP stdio/admin imports/declarations passed. A separate installed ArtifactStore process returned `E_SESSION_ALREADY_RUNNING` during the live MCP browser session, left no denied artifact, and wrote successfully after stop. Existing transient MCP/CLI flows passed; independent ZIP/hash checks validated a 164604-byte trace. Cap-1 checkpoint rejection, persisted 2 MiB run allowance and seven events across two three-record rollovers passed. Production audit reported zero vulnerabilities. App PID 21143 exited, port 50870 rejected connections, sessions/client/transport closed, and the temporary consumer was removed. No browser download, remote service or publication was involved.

Reproduction commands (worktree root; focused Vitest from `probefn/`):

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH /Volumes/Dev/n/superfunctions/node_modules/.bin/turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin
PATH=/opt/homebrew/opt/node@22/bin:$PATH node ../node_modules/vitest/vitest.mjs run packages/storage/test/writer-ownership.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH PROBEFN_PLAYWRIGHT_VERSION=1.57.0 PROBEFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js node probefn/scripts/verify-distribution.mjs --browser
```
