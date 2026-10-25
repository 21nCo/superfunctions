# HostFn local process boundary

Original 2026-02-05 RUN-008, RUNNER-003 and INT-006, and 2026-02-07 RUNNER-001/INT-006/INT-007 retain the HostFn integration requirement. This fixes the local Runner boundary; it does not complete remote integration or prove deployment.

## Reproduced behavior

The old helper interpolated environment into an execSync shell command. An owned fake executable plus `production; printf injected > <owned sentinel>` reproduced a second command and wrote the sentinel. `/tmp/cifn-hostfn-baseline.log` retains the expected failing regression. No actual deployment or external provider was invoked.

## Resulting contract

Both public helpers pass literal argv with an option terminator. Managed Runner uses the existing process supervisor, host-owned executable resolution, bounded capture, streamed redaction, cancellation and timeout. Job PATH cannot replace the selected executable. Managed execution always supplies required --ci; hostfn-runner defaults to --local unless explicitly overridden. The synchronous helper retains optional flag and inherited-environment compatibility but does not claim group cleanup; timeout/signal/capture overflow throws uncertainty.

Uncertain termination preserves existing error identity and the Runner workspace. Process exit does not attest deployment outcome beyond the reported command result. Invalid admission returns sanitized errors. These are POSIX process controls, not an untrusted repository sandbox. RemoteRunner still rejects HostFn steps; provider credentials, deployment receipts and remote durable integration remain open.

## Validation

Final validation passed on the checkpoint source:

- 119 selected tests across 13 files, including seven HostFn cases, archive paths, remote execution/replay, checkout, Docker ownership/protocol, step/log journals and actual TestFn integration. This is not the entire legacy suite; external-clone/provider tests were not run.
- Runner strict remote/source declarations and build passed on Node 20.20.0.
- Built public HostFn helper and Runner acceptance used an owned executable, verified literal arguments, required CI/local defaults, redaction and observable process termination.
- Fresh 11-tarball Node 22.22.0 consumer passed actual public HostFn execution plus existing local Git/SQLite/LogFn contracts, ESM/CJS imports, strict declarations and production audit with zero findings. No native Docker or external deployment was inferred from this consumer.

Receipts: `/tmp/cifn-hostfn-selected-final.log`, `/tmp/cifn-hostfn-types-final.log`, `/tmp/cifn-hostfn-build-final.log`, `/tmp/cifn-hostfn-native-final.log`, `/tmp/cifn-hostfn-packed-final.log`. Reproduce the installed fixture with `CIFN_NPM_CLI` pointing to npm 11, Node 22 in PATH, and `node cifn/typescript/control-plane/scripts/verify-packed-logs.mjs` after package builds. The standalone fixture is `cifn/typescript/runner/scripts/verify-hostfn-argv.mjs`.

All commands exited successfully. Owned HostFn fixtures and the fresh consumer were removed after success; the fixture retains its exact private directory on failure rather than claiming cleanup of uncertain processes. No settings, external resources, ignore files, dependency declarations or root lock metadata changed. Full original readiness remains open as recorded in the requirement audit.
