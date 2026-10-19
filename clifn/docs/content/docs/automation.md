---
title: Subprocesses and scaffolding
description: Execute commands and create files with explicit limits and overwrite policy.
---

`@clifn/core/exec` exports `createExec()`. Call `command(file, args, options)` with a separate executable and argument array. The result includes command, exit code or signal, captured stdout and stderr, timeout state, and duration. Capture defaults to one MiB per stream; set `maxBufferBytes` to change it. Output beyond the limit is dropped from the captured `stdout`/`stderr` without an error or flag, although streaming callbacks still receive every chunk. Timeout defaults to 30 seconds. Pass callbacks or `streamOutput` to observe chunks while the command runs.

```ts
import { createExec } from "@clifn/core/exec";

const result = await createExec().command("git", ["status", "--short"], {
  cwd: process.cwd(),
  timeoutMs: 10_000,
});
if (result.exitCode !== 0) throw new Error(result.stderr);
```

On timeout, `ExecTimeoutError` carries code `CLIFN_EXEC_TIMEOUT` and the partial result. The child receives SIGTERM, then SIGKILL after a short grace period. `runAction()` exposes this service as `ctx.exec` with inherited working directory and environment.

`@clifn/core/scaffold` exports `createScaffold()`. Its `apply()` accepts `mkdir` and `write-file` operations, a working directory, and `dryRun`. Each `write-file` operation sets `ifExists` to `error` (default), `skip`, or `overwrite`. It returns written and skipped paths. The service resolves the real path of the nearest existing path and rejects a target that escapes the configured root, including through an existing symlink. A dangling symlink (one whose destination does not exist yet) is not detected, and `write-file` follows it, so do not scaffold into directories that untrusted parties can write to.

```ts
import { createScaffold } from "@clifn/core/scaffold";

const result = await createScaffold().apply([
  { kind: "mkdir", path: "src" },
  { kind: "write-file", path: "src/index.ts", content: "export {};\n", ifExists: "skip" },
], { cwd: process.cwd(), dryRun: false });
console.log({ written: result.written, skipped: result.skipped });
```

With `dryRun`, `apply()` writes nothing and returns the planned `written` and `skipped` paths; it does not print them, so display the result yourself before applying it. `ScaffoldError` carries `CLIFN_SCAFFOLD_EXISTS` or `CLIFN_SCAFFOLD_INVALID_PATH`.
