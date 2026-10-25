# GitHub event identity and trigger admission

Original 2026-02-05 PIPE-004 requires push/PR branch triggers to govern run admission; INT-005 and RUN-007 require trigger repository/ref checkout. The old handler read top-level `ref` for both events, rejected real PR payloads, resolved a mutable branch and ignored the pipeline's event/branch configuration. Prior PR tests used a push-shaped payload and did not exercise that contract.

The resolver prerequisite is isolated in commit `30ec2a8f8585b9c96481a29b484d5983a0db7b72`. This slice normalizes signed push and same-repository PR identities before resolution. Config resolution and default checkout use the captured SHA. PR filters use the base branch; expression context preserves head ref, repository name and SHA. Checkout takes the accepted pipeline repository URL, without rewriting expression repository identity. User-specified checkout overrides remain supported.

The original schema and phase report explicitly allow omitted branch lists; no glob semantics are specified. Event absence rejects admission, omitted branch list permits all, empty permits none, and entries are literal names. GitHub PR opened/reopened/synchronize actions are supported. Other PR actions, deleted refs and tag pushes are acknowledged as skipped. Fork PRs fail closed before config resolution; fork authorization/secret isolation remains an open requirement, not completed PR readiness.

Pipeline filters run after resolving and validating config but before job-secret resolution, durable run admission or queue publication. Fork/action gates run before config resolution. Authenticated retries are not webhook-delivery-ID deduplicated. Non-ResolverError failures return a generic message rather than adapter diagnostics.

The built server now supports explicit `CIFN_PIPELINE_RESOLVER=git` (default off), optional configured `CIFN_GIT_TOKEN`, and separate trusted `CIFN_ALLOW_LOCAL_REPOSITORIES=true` (default false). Shutdown aborts supervised resolver work; arbitrary secrets-adapter I/O remains outside forcible cancellation. The Git transport's existing isolation, timeout and uncertain-process retention boundaries remain unchanged.

## Validation status

The untouched control-plane distribution built during prerequisite `30ec2a8f8` reproduced both defects before rebuilding the trigger changes: a real PR-shaped delivery returned 400 before resolution, while a push against a workflow-dispatch-only pipeline returned 201 and persisted a run. `/tmp/cifn-trigger-baseline.log` records this local memory-only reproduction; no network requests were made.

Final validation passed:

- Full control-plane suite: 229 tests, including 30 focused trigger/normalization checks; `/tmp/cifn-trigger-control-full.log`.
- Selected runner regressions: 75 tests across remote runner, checkout, spool, step journal, artifacts/cache and TestFn integration; `/tmp/cifn-trigger-runner-selected.log`. Legacy runner tests that clone public repositories were not run.
- Control durable and runner remote TypeScript configurations, plus both package builds; `/tmp/cifn-trigger-types-final.log`, `/tmp/cifn-trigger-runner-types-final.log`, `/tmp/cifn-trigger-control-build.log`, `/tmp/cifn-trigger-runner-build.log`.
- Actual built Node 20 HTTP/SQLite/local Git acceptance; `/tmp/cifn-trigger-native.log`.
- Fresh Node 22.22.0/npm 11 installed consumer: 11 tarballs, ESM/CJS, strict declarations, real HTTP/SQLite/local Git and production audit 0; `/tmp/cifn-trigger-packed.log`.

The built and installed fixtures send a signed PR through the actual server, resolve an owned local bare repository, move its branch to invalid newer config after capturing the event SHA, execute default checkout, then verify successful state after SQLite reopen. They also verify signed base-branch skips and fork denial. Existing lost acknowledgement, killed runner, no-shell-replay, manual observed-owner adjudication, LogFn delivery and durable status checks remain green.

One orchestration command attempted a nonexistent runner `typecheck` npm script and stopped before native execution (`/tmp/cifn-trigger-runner-types.log`). The corrected command used the existing `tsconfig.remote.json` and passed; no source gate was removed or weakened. Initial focused commands invoked from the wrong directory were corrected to the actual workspace before results were recorded.

All validation sessions exited. Fixture-owned processes, loopback servers, temporary repositories/workspaces, SQLite and installed-consumer directories were cleaned by their acceptance helpers. No external repository/provider calls were made. No push, base merge or deployment was performed. Fork trust policy, webhook delivery deduplication, live GitHub/PlugFn integration, repository storage quota and uncertain-process/operator boundaries remain open as described above and in the prior checkpoints.
