# DevFn test support

Test-only helpers shared by the DevFn packages' Vitest suites. Nothing here ships: no
package lists this folder in `files`, and the modules use Node built-ins only, so a
package installed and tested on its own still loads them from the repository checkout.

## Leak guard

`leak-guard.mjs` keeps a test run from leaving processes or temp directories behind.
A DevFn wrapper detaches into its own session, so stopping the test runner's process
group does not stop it; the guard finds what a run started by where it runs instead.

Each package's `vitest.config.ts` loads it as `globalSetup`, and `test/leak-guard.setup.ts`
calls `guardTestFile` as a setup file.

- The run gets its own temp root (`devfn-tests-*` in the original temp folder), and each
  test file a folder inside it. `TMPDIR`, `TMP` and `TEMP` point there, so DevFn and the
  processes it starts create their temp files there too. The names are short because a
  Unix socket path in `TMPDIR` has room for about 103 bytes on macOS.
- A process belongs to a file or run when its command, working directory or environment
  names that folder or a directory registered with `guardDirectory`, when it inherited the
  file's or run's marker variable, or when it descends from the file's worker process or the
  run's own process. The guard never signals any other process.
- After a test fails or times out, the guard stops the processes that test started, with
  the detached process group each leads, and removes the temp entries it created: the
  test's own `finally` may still be waiting on the call that stalled.
- After a test file's own hooks, the guard fails the file when one of its processes is
  still running or a temp entry remains, lists them, and then stops and removes them.
- When the run ends it does the same for the whole run (and, with
  `DEVFN_REAL_COMPOSE=1`, for Compose containers whose project directory is in the run's
  temp root), and fails the run.
- The run's check also fails on, and lists, processes it cannot attribute to itself: those
  that started during the run, run from or name a path in the worktree, and were orphaned
  (re-parented to init), as a detached wrapper is once the command that started it exits.
  It never signals them. A process still under this run's or a sibling turbo task's process
  tree, one that was already running (an editor, say), and one that a sibling guarded run
  still going attributes to itself are not listed. Nor is one whose path is only in a
  checkout nested in the worktree (such as `.worktrees/<task>` under the main checkout) or
  in a sibling directory whose name merely starts with the worktree's (`repo-dev-42` beside
  `repo`): a path counts only where the root is followed by `/`, a delimiter or the end.
- When the run is interrupted (Ctrl-C, or turbo cancelling the task after a sibling
  failed), it stops what the run started, including processes running from directories
  registered with `guardDirectory`, and removes those directories and the temp root as the
  process exits.

A directory a test creates outside the temp folder, such as one under the package's
`node_modules/.cache`, is added to the file's guard with `guardDirectory(directory)` before
the test starts anything there. The registration is also recorded in the run's root, so
the run's own check and its interrupt cleanup cover it.

## Machine-wide locks

Fixtures in different files, packages and runs that share a fixed resource, such as
Caddy's admin port `127.0.0.1:2019`, lock it with `caddyAdminLockPath()` or
`machineLockPath(name)` from `shared-locks.mjs`. These name a lock in the temp folder the
outermost run started with, not the per-file `TMPDIR`, so every file contends on the same
lock.

The guard lists processes with `/proc` on Linux and `ps` and `lsof` on macOS. On other
platforms it checks only temp entries, and says so.

## Temp directories

`temporaryDirectories(afterEach)` returns a function that creates a temp directory and
removes it after each test, first stopping any process still running from it. Use it for
a directory a test creates, so a failing or timed-out test cleans up as well.

```ts
import { afterEach } from "vitest";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

const tempDir = temporaryDirectories(afterEach);

it("starts a runtime", async () => {
  const root = tempDir("devfn-example-");
  // …
});
```

`devfn/testing/test/leak-guard.test.ts` runs small guarded projects that leak on purpose
and checks that each run fails, names what was left, and leaves nothing behind (except an
unattributable worktree orphan, which it lists and the test then stops itself).

Each guarded package's `turbo.json` adds this folder to its `test` inputs, so a change here
reruns the packages' tests instead of replaying cached results.
