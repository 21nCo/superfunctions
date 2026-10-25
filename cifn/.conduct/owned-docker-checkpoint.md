# Owned async Docker protocol checkpoint (native acceptance open)

The separate `5b72179df3b3123fd1b27f8a7baf7e494443ced8` checkpoint fixes silent host fallback for image-required jobs. This follow-up implements the explicit asynchronous executor path needed by original 2026-02-07 RUNNER-002; it does not establish full Docker readiness or hostile-fork isolation.

## Implemented path

`OwnedDockerExecutor` is exported by the actual runner package, accepted by Runner/RemoteRunner, and enabled in the built remote server only by trusted `CIFN_DOCKER_CONTEXT`. The remote path associates each receipt with durable run/dispatch/execution/runner identity, excluding its claim token. No configuration means image jobs remain rejected. The synchronous public executor remains a compatibility path, not the remote implementation.

Before create, the executor saves and fsyncs private ownership metadata, with a unique name, explicit context, daemon identity and canonical workspace. State must have private permissions and resolve outside the workspace mount; an in-workspace directory is rejected before writing environment/receipt data or contacting Docker. Environment values use a mode-0600 file, and the interpolated shell command is supplied through the owned CLI environment and a fixed wrapper, not argv. Docker's env-file bare-variable behavior is documented by its official CLI reference: https://docs.docker.com/reference/cli/docker/container/run/ . The privileged daemon/container still sees this environment.

Safe argv subprocesses reuse the existing shared Ci owned-process supervisor. Creation never pulls an image. Attach streams through the current redaction/status path; output truncation marks the durable spool once. Cleanup verifies daemon, exact container ID and ownership label before force-removing that container, then confirms absence. Failed/uncertain creation, CLI ownership, daemon identity or removal retains the private receipt/workspace and propagates `ProcessGroupUncertainError` to existing execution reconciliation. No stale receipt automatically kills or replays anything. Output callback errors are surfaced after container cleanup rather than escaping a Node stream event handler.

## Evidence and limitations

The explicitly selected `desktop-linux` daemon failed to answer a five-second `docker info` probe again. No settings changed, Docker app restarted, images pulled or containers created. The native acceptance script `typescript/runner/scripts/verify-owned-docker.mjs` is syntax checked and opt-in only; **it has not passed against Docker**. It requires a host-selected context and already cached image with `/bin/sh`, checks success/nonzero/cancellation, and preserves unresolved ownership evidence.

Source protocol tests use a controlled transport, including secret-free argv, private files, ownership mismatch/no foreign removal, uncertain create, failed removal, active cancellation, output failure, remote routing/truncation and actual Runner workspace retention. The fresh installed consumer runs the exported executor through the real RemoteRunner execution helper with a controlled transport, explicitly reporting `nativeDocker: false`. It verifies package/runtime wiring, not Docker engine behavior.

Validation logs and final counts are recorded below after terminal completion. The selected suite deliberately excludes legacy tests that clone external GitHub repositories. No external provider calls are part of this checkpoint.

## Required remaining work

- Actual Docker engine acceptance for success, exit status, cancellation, lost create/start replies, daemon failure and process crash/reopen. A mocked transport cannot close this gate.
- Original persistent per-job container semantics: this implementation creates a separate container per run step, retaining only the shared workspace.
- Enforced untrusted-code execution profile, resource/network/nonroot policy, isolation of checkout and all provider steps, and private credential boundaries.
- Durable bounded retention/quota/operator maintenance for unresolved container receipts. An ambiguous create may retain its private environment file; a stale heartbeat or missing CLI is not proof the container stopped.
- Env-file multiline values are rejected, with at most 256 entries/256 KiB environment and a separate 256 KiB command cap. No claim of full unrestricted environment parity.
- The configured attach timeout is separate from bounded info/create/inspect/remove operations; it is not a whole-operation wall-clock deadline. Existing server shutdown waits for the current tick.

## Terminal validation receipts

- `/tmp/cifn-docker-async-runner.log`: 65 selected tests passed before the final callback/containment corrections. This includes existing remote, checkout, journals and new async protocol cases.
- `/tmp/cifn-docker-async-runner-final.log`: 50 selected tests passed after consolidating the truncation callback to one invocation. The command intentionally selected fewer existing files than the prior 65-test run.
- `/tmp/cifn-docker-async-focused-final.log`: all 11 async protocol tests passed after adding the canonical state/workspace containment regression. This includes actual Runner workspace retention on uncertain cleanup; it does not start Docker.
- `/tmp/cifn-docker-async-types-final.log`, `/tmp/cifn-docker-async-build-final.log`: final remote typecheck and ESM/CJS/declaration build passed.
- `/tmp/cifn-docker-async-packed-final.log`: final normal Node 22.22.0/npm 11 fresh 11-tarball consumer passed. Actual installed async protocol reports `installedOwnedDockerProtocol: true, nativeDocker: false`; strict declarations, ESM/CJS and production audit 0 passed. The same consumer reran actual local Git, signed fork/PR, SQLite reopen, killed-runner logs/status, lifecycle/step-output and no-host-fallback acceptance.
- Native opt-in script syntax and `git diff --check` passed. No Docker engine acceptance was run; its read-only availability probe timed out. All owned test/consumer processes exited and temporary acceptance directories were removed. No root metadata/dependencies or `.gitignore` changed.

Two initial test invocations used a package-relative binary from the wrong directory and exited before executing tests; they were corrected to the actual runner working directory. No runtime gate was weakened or fabricated to compensate for daemon unavailability.
