# Remote HostFn execution checkpoint

Original 2026-02-05 RUN-008, RUNNER-003 and INT-006, plus 2026-02-07 RUNNER-001/INT-006/INT-007 require HostFn invocation with CI mode and prepared secrets. The preceding local argv checkpoint did not enable the durable remote runner. A focused baseline showed the remote provider gate rejecting an explicitly host-configured deployment before the owned fake executable ran (`/tmp/cifn-remote-hostfn-baseline.log`).

## Behavior

RemoteRunner accepts a bounded trusted policy: absolute executable, 1ms–1hour timeout, 1–32 unique exact labels, fixed boolean local mode. Configuration is snapshotted; pipeline options cannot replace it. The built runner accepts this host configuration as at most 8 KiB JSON in CIFN_HOSTFN_POLICY. Default provider denial remains. Image-required jobs containing deployment are denied before any step; there is no host fallback around container selection.

Actual execution reuses the existing asynchronous HostFn argv helper, prepared secrets, owned process supervisor, StepJournal, LogSpool and claim journal. Completed results survive lost ACK/restart without command replay. Cancellation uses the existing authenticated claim monitor. A killed runner leaves the started claim uncertain even after the fixture independently observes its owned fake process exit; no automatic completion or replay is inferred.

A successful CLI result is not independent provider-side proof. Closing a local process does not roll back an already-submitted deployment. Real external HostFn/provider acceptance, remote FileFn/cache/TestFn support, and full original production readiness remain open.

## Evidence

Final validation passed:

- 123 selected tests across 14 files, including four new policy/admission cases and existing HostFn argv/cancellation, archive, checkout, Docker ownership, journals and TestFn integration: `/tmp/cifn-remote-hostfn-selected-final.log`.
- Strict source/declaration checks and Runner build: `/tmp/cifn-remote-hostfn-types-final.log`, `/tmp/cifn-remote-hostfn-build-final.log` (Node20.20.0).
- Standalone built HTTP/SQLite acceptance: `/tmp/cifn-remote-hostfn-native.log`.
- Fresh 12-tarball consumer on Node22.22.0: `/tmp/cifn-remote-hostfn-packed-final.log`. Actual remote HostFn and prior cron/checkout/log/status/SQLite contracts, ESM/CJS imports, strict public RemoteHostFnPolicy declarations, and production audit zero all passed. No new dependency was needed.

This is selected Runner coverage, not a claim that every legacy/external-provider suite ran. The focused unsupported baseline is preserved separately. Source and installed fixtures prove policy snapshot stability after caller mutation and literal built-runner argv. Native fixture uses actual loopback control HTTP, SQLite reopen and the built runner policy environment. It observes three fake executions only: committed success with lost completion ACK, cancellation, and runner SIGKILL followed by uncertain no-replay. Owned fake processes self-terminate within five seconds after crash; cleanup waits for observed exit and retains evidence if it cannot prove termination. No provider deployment is performed.


All final commands exited zero. Owned control/runner children and fake provider processes exited; temporary fixture directories and the fresh consumer were removed. No Docker/container/provider resources were started for this slice. No deployment, settings, root metadata, lockfile or ignore changes occurred. The public fixture is `cifn/typescript/runner/scripts/verify-remote-hostfn.mjs`; the fresh consumer invokes it automatically after package builds.
