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
  `repo`), nor, in a macOS listing, one that names the worktree cut short at a space, quote
  or `:` where an entry beside the worktree continues its name there (`repo copy/x` or
  `repo copy --flag` with `repo copy` existing); any other such match, `repo --flag` say, is listed. A command,
  environment or working directory names a path under a root only through a complete path
  value equal to the root or starting with `root/`, once its `.` and `..` segments are
  resolved as the system resolves them (`..` through a symbolic link goes up from the
  link's target), so `<root>/../x` is not under the root. A `..` value that is under the
  root only as written (as Node resolves a script) or only as the system resolves it, such
  as `<root>/link/../x` or `<root>/missing/../x`, is reported but never signalled on its own. On Linux,
  `/proc` keeps each argument and variable whole, NUL-separated, so a value is a whole
  argument (after a `KEY=` or `--option=` prefix and `file://`) or a whole variable's
  value; only a variable known to hold a list (`PATH`, `NODE_PATH`, `LD_LIBRARY_PATH`...) is split at
  `:`. An argument `<root>:x` or `<root> x` is never under the root there. On macOS, the
  `ps` listing joins arguments with spaces and cannot show where one with a space, quote or
  `:` in it starts or ends (`node /x <root>/y` may be one argument `/x <root>/y`), whether or
  not such a path exists. So there a process whose only link to the run is a path in its
  command or environment fails the run and is listed, but is never signalled: the guard
  signals it only with independent evidence, its marker, its working directory or its
  descent (for `temporaryDirectories`, also the file's or run's marker or descent from the
  test's worker). Shell punctuation such as `;`,
  `,`, `(`, `&`, `|` or `<`, like `-`, `.`, `[` or a non-ASCII letter, can be part of a
  file name, so `/x/repo;other` is not under `/x/repo`. A process a shell started that way
  is still attributed by its marker, working directory or parent. The same rule decides
  which processes the guard owns and may signal.
- When the run is interrupted (Ctrl-C, or turbo cancelling the task after a sibling
  failed), it stops what the run started, including processes running from directories
  registered with `guardDirectory`, and removes those directories and the temp root as the
  process exits. It lists everything the run's check would, worktree orphans and processes
  it can only report included, from the same classification of one process listing, and
  fails the run even when it exits with success. This stays armed until the run's teardown
  has finished, so a run interrupted while the teardown waits for leftovers still cleans up
  and reports them.
- Before failing a file or the run, the guard gives every process it found, those it can
  only report as well as those it would stop, the same short while to exit by itself, and
  reports what it cannot stop from one listing taken once stopping is done. A process of
  its own that appears in that listing is stopped and listed too.
- The run lists a folder the guard made for a test file (recorded in the run's root) by its
  contents; any other entry in the root, whatever its name, is listed itself.
- A temp root or file folder the guard cannot remove fails the run, or the file, and is
  named, like any other leftover.
- Stopping sends SIGTERM, then SIGKILL to each process and to every process group one of
  them led, even once the leader has exited, since what it started on its way out (a
  wrapper's SIGTERM handler starting a child, say) is still in that group. The guard then
  lists the scope's processes again and kills what is left, until nothing is or 10 seconds
  have passed; anything still running fails the run or the file.

A directory a test creates outside the temp folder, such as one under the package's
`node_modules/.cache`, is added to the file's guard with `guardDirectory(directory)` before
the test starts anything there. The registration is also recorded in the run's root, so
the run's own check and its interrupt cleanup cover it.

## Machine-wide locks

Fixtures in different files, packages and runs that share a fixed resource, such as
Caddy's admin port `127.0.0.1:2019`, lock it with `caddyAdminLockPath()` or
`machineLockPath(name)` from `shared-locks.mjs`. These name a lock in the temp folder the
outermost run started with, not the per-file `TMPDIR`, so every file contends on the same
lock. Call them in the process that takes the lock, before taking it.

Naming a lock also records it in the run's root, since the lock lives outside it. When the
run is interrupted, or ends, after stopping its own processes the guard removes each such
lock (and any `<lock>.released.*` copy withFileLock left) whose `owner.json` names a process
that named that lock in this run, took it after doing so and is now gone, and lists it as a
leftover. Otherwise a killed holder's lock would block every later run until it is old
enough to recover. A lock held by another run's process, or by a process still running, is
never touched.

withFileLock (`@devfn/ports`) lets any waiter take over a dead holder's lock once it is
`staleMs` old, replacing its `owner.json` in place, and keeps other takers out only through
its takeover markers (`owner.takeover.<record hash>.<generation>`, see `recoverLock` in
`devfn/ports/src/lock.ts`). The guard follows the same protocol: it links the record's next
marker itself, passing a generation only when its taker is dead, and while holding it moves
the lock aside only if `owner.json` still shows the dead holder's record. A waiter can then
neither take the lock over nor be moved away mid-takeover, whatever the lock's age. A lock
another live process holds a marker for is left in place and listed, so the run fails. The
guard's marker carries its birth signature, as withFileLock's records do, so a guard killed
while holding it never blocks a waiter, even once its process ID is reused.

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
