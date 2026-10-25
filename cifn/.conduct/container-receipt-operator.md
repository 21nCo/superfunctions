# Retained container operator inspection and cleanup

## Requirement boundary

Original 2026-02-05 RUNNER-001 requires the default process/Docker-per-job path; RUNNER-005 requires persisted step/job status. The current killed-owner fixture proves that a retained daemon exec can remain alive after the owning process exits. The operational gap was the absence of a supported host cleanup path for that retained identity. Neither dated requirements document specifies an automatic recovery algorithm or a numeric receipt TTL. This slice preserves that distinction and does not infer execution completion from cleanup.

## Contract

`OwnedDockerExecutor.inspectReceipt(id)` performs exact-ID, bounded 16KiB, private regular-file/O_NOFOLLOW validation of a version-2 per-job receipt and projects identity/fingerprint without workspace or command/environment. `cleanupReceipt` requires the exact fingerprint, owner, stable operator ID and explicit stopped-owner attestation. It uses an fsynced exclusive per-receipt lock, validates the context/daemon/container label, removes only the known container, and checks both ID and name absent. It revalidates the original receipt afterward. A separate immutable terminal cleanup receipt is published with an exclusive link; it never overwrites another decision. Exact retry/reopen returns the same projected receipt without daemon I/O. Unknown outcome remains unknown.

The lock serializes cooperating operators, not a live original owner or malicious local filesystem mutations. Interrupted or ambiguous I/O retains the lock and original receipt. No PID-age stealing, missing-container completion inference, shell replay, workspace deletion, broad directory inventory, historical v1 migration, unknown-create reconciliation or TTL pruning is introduced. A lock abandoned by a killed cleanup caller requires explicit offline repair after proof that caller stopped. Terminal receipt/lock disk quota remains open.

## Validation

Initial 25 focused ownership/Engine/receipt tests passed; the final six receipt tests include exclusive terminal publication and no-overwrite behavior. Remote types and builds passed. The actual cached `alpine:3`, explicit `desktop-linux` fixture passed per-job behavior plus killed execution-owner identity, an independent cleanup process holding the durable lock, second-caller denial, lock retention after killing that exact cleanup process, fixture-only offline repair, actual public cleanup and terminal replay after reopening.

Initial fresh 11-tarball Node22 installed consumer passed ESM/CJS, strict public receipt API declarations, actual Unix transport, actual Docker, existing local Git/SQLite/status/LogFn contracts and production audit zero. Final rebuilt immutable-publication acceptance also passed: 26 focused tests across four files, remote TypeScript, runner ESM/CJS/declaration build, and fresh 11-tarball Node22 installed consumer with the actual cached Docker/operator fixture, strict public declarations and production audit zero. Lock serialization persists validated fields only; extra runtime object properties are excluded. Final independent owned-container label inventory was empty, and owned children/private fixtures/packed consumer were removed. No image pulls or external provider sends.

Logs: `/tmp/cifn-operator-focused.log`, `/tmp/cifn-operator-focused-final.log`, `/tmp/cifn-operator-types-final.log`, `/tmp/cifn-operator-build.log`, `/tmp/cifn-operator-native.log`, `/tmp/cifn-operator-packed.log`, `/tmp/cifn-operator-build-final.log`, `/tmp/cifn-operator-packed-final.log`.
