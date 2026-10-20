# Bounded process-group disappearance checks

The POSIX cleanup path previously treated every `kill(-ownedGroupId, 0)` error other than ESRCH as an immediate cleanup failure. On this Darwin 27 arm64 host, a disposable process-tree diagnostic reproduced a short transition after successful SIGKILL: the owned group's existence probe returned EPERM, followed by ESRCH on a later poll. This happened in 23 of 30 rounds. Some simultaneous positive-PID probes still observed the dying descendant; subsequent probes confirmed both group and descendant absent. No credentials or process identities were changed by the fixtures. This is direct evidence of transient existence-probe uncertainty during teardown, not evidence that all EPERM errors are harmless or that the exact kernel-internal cause has been established.

Cleanup now treats EPERM from signal zero as presence/uncertainty and continues the existing bounded wait. Successful cleanup still requires child/stdio closure and ESRCH for the owned process group. If the final wait expires with a permission-denied probe, the original EPERM is surfaced and session ownership remains available for retry. Successful existence probes clear a previous transient error. Errors from actual SIGTERM/SIGKILL remain explicit; no privilege elevation, broader process search, unrelated signal target, timeout extension, or permission bypass was introduced.

Validation:

- `npm test --workspace=@probefn/workspace -- packages/dev-server/test/process-lifecycle.test.ts`: 21 tests pass. Includes eight actual resistant descendants with ignored stdio, deterministic transient and persistent signal-zero errors, retained ownership/retry, and the existing actual-signal permission failure. `/tmp/probe-eperm-tests.log`.
- Full unified suite: 162 tests pass across 33 files, including actual Chromium, CLI and MCP coverage. `/tmp/probe-eperm-full-tests.log`.
- `npm run typecheck --workspace=@probefn/workspace`: passes. `/tmp/probe-eperm-types.log`.
- Native pre-fix diagnosis: `/tmp/probe-owned-group-diagnosis.mjs` and `/tmp/probe-owned-group-diagnosis.log`; 30 directly spawned process trees, all terminal group/descendant probes ESRCH, fixtures cleaned up. Exact observations are preserved in `process-group-probe-native-20261020.json`.

The diagnostic and runtime checks are local macOS evidence. Windows process-tree cleanup, descendants that deliberately leave the owned process group, hung storage, and durable disk quota remain separate limits. A real permission failure still blocks confirmed cleanup. The historical report-export suite EPERM is retained in its original receipt; this change addresses the reproduced existence-probe transition without weakening its descendant-cleanup assertion.
