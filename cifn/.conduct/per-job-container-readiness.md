# Per-job Docker state and owned Engine execution

Original 2026-02-05 RUNNER-001 explicitly includes Docker per job. The 2026-02-07 RUNNER-002 also requires image-backed run steps with workspace mounts and calls runtime specifics implementation-defined; this does not waive the earlier per-job contract. The previous single-step owned executor lost container filesystem state between steps.

## Native baseline and scope

On the resumed run, the single explicit `desktop-linux` availability probe succeeded. Cached `alpine:3` was used without a pull or Docker settings changes. The earlier standalone lifecycle passed three actual cases (success/environment/workspace, exit7, active cancellation): `/tmp/cifn-owned-docker-native-first.log`, with independent final owned-label inventory empty. This supersedes only the earlier daemon-unavailability evidence, not all readiness limits.

The actual two-step baseline wrote `/tmp/cifn-owned-layer` in the first container and failed to read it in the second, while the first step succeeded: `/tmp/cifn-per-job-container-baseline.log`. Both containers and private fixture state were removed.

## Resulting behavior

Runner now lazily opens one owned container per job. Run steps execute through local Unix-socket Engine exec create/start/inspect, preserving container state after authoritative zero and nonzero exits. An `always()` successor after a normal failure sees the same filesystem. Each exec ID is fsynced before start; the result validates exec ID, container ID, Running=false and integer exit status. Docker CLI exit is not used to infer exec completion.

The client decodes bounded multiplexed stdout/stderr, preserves split UTF-8 and line framing, and settles its owned HTTP connection before returning success or failure. Errors are sanitized; raw Engine response bodies are not propagated. Unix-socket context and daemon identity are host-selected and checked; unsupported TCP/SSH contexts fail closed before creation. Engine create does not pull an image. These contracts follow Docker's Engine exec API: https://docs.docker.com/reference/api/engine/version/v1.40/ .

A command's timeout/abort/unknown response closes admission. Verified force-removal permits an explicit infrastructure-failed job with remaining steps skipped, including `always()`; it never silently opens a replacement container. Failed removal retains receipt/workspace and uncertain execution state. Job finalization closes the container before workspace deletion or job completion. Public session close joins an active command and is idempotent within the owner process.

Per-job environment/command data goes only into bounded local Engine bodies, not argv or receipts; multiline values work. The older standalone `execute()` API retains its documented env-file/single-line behavior. Private state must be outside the canonical workspace. No shared/root dependency or ignore changes are needed.

## Validation

Final validation on Node20 source and Node22 installed consumer:

- 75 selected Runner tests across eight files passed, including owned process cancellation, checkout, step journal, log spool, container admission, Engine framing/connection cleanup and per-job session lifecycle. This is the scoped Runner suite, not a fresh full control-plane suite. `/tmp/cifn-perjob-selected-final.log`.
- Remote TypeScript checks and runner ESM/CJS/declaration build passed: `/tmp/cifn-perjob-types-final.log`, `/tmp/cifn-perjob-build-final.log`.
- Actual cached `alpine:3` on explicit `desktop-linux`: preserved per-job filesystem, known failure plus `always()` successor, multiline environment, active cancellation with no later admission, killed-owner receipt and live exec identity after reopening, explicit fixture-only cleanup all passed. `/tmp/cifn-perjob-native-final.log`.
- Fresh normal-installed 11-tarball consumer passed Node22 ESM/CJS, strict declaration consumer, actual owned Unix HTTP transport, the same actual Docker fixture, existing signed-trigger/local-Git/SQLite/crash replay/LogFn acceptance, and production audit zero. `/tmp/cifn-perjob-packed-final.log`. The transport fixture reports `nativeDocker:false` separately from the subsequent real Docker fixture's `nativeDocker:true`.
- Final independent `docker --context desktop-linux container ls --all --filter label=io.21n.cifn.owner --format '{{.ID}}'` returned no rows. Owned native children and private fixture directories were removed; the fresh packed consumer was removed. No image pull, daemon settings change, external provider send, root metadata or ignore change.

The native fixture deliberately kills an owned runner child after observing active execution, rereads its durable exec ID, verifies that exact ID still belongs to the live owned container, and performs explicit fixture-only cleanup after validating daemon/owner/container identity. This is evidence of crash retention, not an automatic recovery feature.

## Still required

A safe operator/product recovery API for retained receipts, durable admission/retention quotas, restart race coverage, supported remote context transports, enforced untrusted-code resource/network/nonroot isolation and isolation of non-run providers remain open. A socket or daemon failure can retain state requiring explicit reconciliation; stale heartbeat/CLI disappearance is not proof of stopped execution. Private Docker credentials and arbitrary untrusted fork code are not made safe by this container implementation alone. The original full CiFn readiness scope remains open.
