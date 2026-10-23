# Explicit TypeScript framework workspaces — 2026-10-23

The CiFn integration exposed a global directory race: two overlapping asynchronous
runs changed the host working directory and restored different saved values. The
corrected before-fix fixture leaves the host in the first workspace even when the
framework runs succeed. A global mutex would not protect unrelated host code.

TestFn now accepts `TestFnConfig.cwd`, snapshots and canonicalizes it before the
first await, and passes it to discovery and execution. Built-in adapters resolve
the installed framework CLI, selected files, subprocess cwd, Playwright config
and outputs, and path-only framework artifacts against that workspace. Resolving
symlinks also prevents framework file filters from disagreeing with the child's
canonical cwd (for example macOS `/var` versus `/private/var`). The existing
process-group supervisor and its timeout/cancellation behavior remain in use.

Validation in the integrated Ci worktree:

- TypeScript build/typecheck passed.
- All 58 TestFn core tests passed, including independent concurrent Vitest runs,
  host cwd changes during pending runs, default cwd capture, path-only artifact
  resolution and existing subprocess cleanup tests.
- `node testfn/typescript/scripts/verify-workspaces.mjs` passed actual installed
  Vitest, Jest, Playwright and Node-test/Puppeteer-adapter execution concurrently.
  Each fixture writes only its own workspace. The host changes cwd while runs
  are pending and retains that new directory. Playwright loads a relative config
  with workspace-specific metadata; generated configs are removed. No browser
  launch or external site/provider access is part of this fixture.
- Ci's 100 runner tests and full runner typecheck pass with this prerequisite.

Custom adapters must honor the optional discovery context and `RunOptions.cwd`.
Caller-supplied reporters, storage configurations and callbacks retain their own
path semantics; use absolute paths if host code can change cwd. This does not
sandbox arbitrary tests or promise isolation for two runs writing the same files.
Python's separate pytest runner is unchanged; this is the TypeScript prerequisite
for Ci's JavaScript runner, not a Python concurrent-workspace API claim. Original
TestFn browser and other production-readiness requirements remain separate.

Receipts: `/tmp/testfn-cwd-build.log`, `/tmp/testfn-cwd-frameworks.log`,
`/tmp/cifn-cwd-tests.log`, `/tmp/cifn-cwd-types.log`. Fixtures remove their temporary
workspaces; no dependency or root lock changes were required.
