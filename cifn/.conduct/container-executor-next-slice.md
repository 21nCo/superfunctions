# Container selection guard and owned executor plan

Original 2026-02-07 RUNNER-002 requires `run` steps inside Docker when `job.image` is provided, and host execution without an image. Original specification also permits arbitrary shell commands; ordinary container use is not itself a hostile-code sandbox requirement satisfied by a mock executor.

## Reproduced selection defect

The existing local `Runner.shouldUseDocker` returned false when no Docker executor was configured. A job with an explicit unavailable image therefore executed its command on the host and reported success. `/tmp/cifn-container-baseline.log` records a real built-package run writing an owned host witness, without Docker/provider access. The initial diagnostic supplied an incomplete log client and stopped before workspace creation; the corrected diagnostic used the public `MemoryLogFnClient`.

The guard now fails container-required steps without invoking a host callback/shell. Container selection also honors host `dockerForDefault` and configured Docker labels. Empty image declarations cannot silently select host execution. Image-free non-container jobs and explicitly configured container dispatch retain their behavior. The remote runner continues its explicit unsupported-image rejection pending actual owned-container support.

## Runtime evidence boundary

A bounded read-only probe found the local Docker Desktop `desktop-linux` context at `unix:///Users/serro/.docker/run/docker.sock`. `docker info` did not respond within five seconds. No settings changed, images pulled, containers created or external accounts/providers accessed. This is an unavailable runtime check, not Docker acceptance. Focused mock routing checks prove only selector behavior. Built and fresh-installed host-witness rejection passed independently of the unavailable Docker daemon:

- 77 selected runner tests, including the two container selector regressions: `/tmp/cifn-container-runner-selected.log`.
- Runner remote typecheck and ESM/CJS/declaration build: `/tmp/cifn-container-types.log`, `/tmp/cifn-container-runner-build.log`.
- Actual built Node 20 fixture confirms `containerHostFallbackDenied: true` and no owned host witness, alongside the existing signed PR/fork/local Git/SQLite/crash acceptance: `/tmp/cifn-container-native.log`.
- Fresh Node 22.22.0/npm 11 normal 11-tarball consumer passes the same witness check, public types, ESM/CJS, durable logs/status/lifecycle and audit 0: `/tmp/cifn-container-packed.log`.

The selected runner suite is not the legacy external-GitHub-cloning suite. Control-plane source was unchanged; its 234 full tests remain the prior fork checkpoint's evidence. One initial command used the wrong working directory and was rerun from the actual runner workspace. Final validation exited 0 and all owned processes/fixture directories were cleaned. No Docker resources were created; Docker execution remains unverified.

## Proposed owned lifecycle

Reuse the existing Ci owned argv process supervisor and the actual Runner/RemoteRunner execution path. Preserve the public synchronous executor interface while introducing an asynchronous owned executor; do not hold the event loop in `spawnSync` for cancellation-sensitive remote jobs.

1. Persist a unique container name, execution-owner identity and exact Docker context/daemon identity before creation in private runner state. Use exclusive ownership labels and verify identity before every stop/remove action. Ambiguous creation is inspected by that recorded identity, never inferred from CLI exit alone.
2. Supply environment through an owned mode-0600 file or equivalent FD outside the repository mount, with no secret values in argv or diagnostic logs. Docker's privileged daemon can inspect container environment; deletion does not provide a hard credential-erasure guarantee. Do not mount the credential file into the workload.
3. Create/start/attach with safe argv and bounded streamed output, preserving existing step-status ordering and redaction. Record container identity and actual exit status. Use explicitly available images for local tests; do not silently pull images while claiming an offline fixture.
4. On cancellation, stop then remove the exact owned container and verify absence before releasing its workspace. A killed Docker CLI does not prove a container stopped. Daemon failure, ownership mismatch or unverified removal retains the workspace/receipt and propagates an uncertainty error compatible with the existing started-execution reconciliation path.
5. Prove success, failing command, active cancellation, lost create/start reply, daemon/cleanup failure, process crash/reopen and no foreign-container deletion with actual local runtime fixtures. A fake CLI alone cannot close RUNNER-002.

For genuinely untrusted forks, a separate enforced profile must cover root/user capabilities, resource quotas, host mounts/socket exclusion, network access and every provider step that can execute code. Host Git checkout, TestFn and deploy/artifact/cache operations cannot be assumed isolated merely because shell steps use a container. Keep that original readiness work open instead of renaming a selector guard as a sandbox.
