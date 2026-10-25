# Exact-code fork approval checkpoint

Original 2026-02-05 PIPE-004/INT-005 require PR-trigger and repository/ref checkout behavior. The preceding checkpoint supports same-repository PRs but denies all forks; it does not complete general PR readiness. The built baseline `/tmp/cifn-next-trigger-baseline.log` confirms a signed fork returns 403 without config resolution. That same baseline confirms repeat delivery IDs create distinct runs; original RUN-004 explicitly permits the same trigger to create a new run, so deduplication is optional hardening rather than a newly invented mandatory requirement.

The new host-only `ForkApproval` policy binds exact base/head repository IDs, names, credential-free URLs and commit SHAs. It is validated, bounded and detached from mutable caller arrays at app construction. The built server reads bounded startup JSON. Payload-supplied approvals never authorize a run. Missing approval or changed identity/SHA fails before resolver access. Config comes from the approved base SHA; default checkout comes from the approved head SHA. Distinct immutable acceptance provenance and approval snapshot are retained in the existing encrypted durable run/dispatch state, with no new storage abstraction.

Discovered pipeline secret names must all be explicitly allowed before `prepareRun` performs any secret reads. The empty default denies all job secrets. Host approval means trusting that exact code with the named secrets; it is not sandboxing. Existing runner permissions and inherited process environment remain a separate isolation requirement. Accepted runs keep their approval snapshot after policy revocation; future admission uses the new policy and existing accepted runs require explicit cancellation if desired.

The memory queue previously omitted trigger payload while durable dispatch retained it. The memory admission path now forwards the accepted trigger too, preserving SHA/expression/provenance semantics through the actual runner path.

## Validation

Final validation passed:

- Full control-plane suite: 234 tests across 17 files (`/tmp/cifn-fork-control-full.log`), including 35 focused trigger/approval checks (`/tmp/cifn-fork-focused-final.log`).
- Control durable and runner remote types plus both builds (`/tmp/cifn-fork-types-final.log`, `/tmp/cifn-fork-runner-types.log`, `/tmp/cifn-fork-control-build.log`, `/tmp/cifn-fork-runner-build.log`). The initial typecheck found an implicit-any callback annotation; the corrected final checks pass without weakening policy or type gates.
- Actual built Node 20 two-repository HTTP/SQLite acceptance (`/tmp/cifn-fork-native.log`).
- Fresh Node 22.22.0/npm 11 normal installation: 11 tarballs, public `ForkApproval` declarations, ESM/CJS, actual HTTP/SQLite/local Git flow and production audit 0 (`/tmp/cifn-fork-packed.log`).

The built and installed fixtures put intentionally invalid config in the fork while approved base config executes head code and compares the checked-out Git SHA with the accepted head SHA. They prove default denial before startup approval, changed head rejection, actual successful execution and distinct config/execution provenance after SQLite reopen. Earlier same-repository, output/step/lifecycle, interrupted-owner and manual adjudication checks remain green. The preceding selected 75 runner tests remain prior checkpoint evidence; no new runner source changed in this slice.

All validation sessions exited 0; owned loopback servers/processes, temporary repositories/workspaces, SQLite and fresh-consumer directories were cleaned by the fixtures. No external provider/repository access, push, deployment or base merge occurred. Untrusted-fork isolation, private-provider credential acceptance and the broader platform matrix remain incomplete; opt-in exact-code trust does not replace those requirements.
