# Shared prerequisite integration — 2026-10-22

Ordinary merge `5db79e404c60d31ed4d453196a83d79b5b65b12b` incorporates Shared
`c0ce24b30ef7935e79a400ed27fcc8ffac1b5d42` into Flow from `4db69ffd8`.
The merge changes shared prerequisites, docs and the root dependency graph;
`git diff 4db69ffd8 5db79e404 -- flowfn` is empty. Flow runtime and Python
source are unchanged. No provider services or performance workloads were started.

Validation on Node 20.20.0:

- Normal npm 11.21.0 `ci --dry-run --ignore-scripts --workspace=@flowfn/core
  --workspace=@flowfn/admin` passes without peer bypass flags. Unrelated DevFn
  packages emit their existing Node >=22 engine warnings. No install or lock
  regeneration was performed; native bindings were preserved.
- `npm run lint --workspace=@flowfn/core` passes.
- `npm run typecheck:tests --workspace=@flowfn/core` passes.
- `npm test --workspace=@flowfn/core -- src/queue/leases.test.ts
  src/queue/lifecycle.test.ts src/core/shutdown.test.ts src/instrumentation.test.ts`
  passes all 25 tests across four files.
- Shared commit ancestry and `git diff --check 4db69ffd8 HEAD` pass.

Logs: `/tmp/flow-shared-ci-dry.log`, `/tmp/flow-shared-types.log`,
`/tmp/flow-shared-test-types.log`, `/tmp/flow-shared-focused.log`.
The committed graph includes root React 19.2.4, Next 15.5.28 and Flow's nested
Vitest 4.1.12. The installed Flow test runner is also 4.1.12. This scoped dry-run
checks dependency resolution, not a new whole-root installation or docs/browser
runtime acceptance. Generated outputs remain ignored; ignore rules are unchanged.

All original gates remain open as previously recorded. In particular,
`queue-claim-performance-readiness.md` still reports Redis below 10,000 jobs/sec
and above the 5 ms enqueue p99 target. PostgreSQL previously exceeded 1,000
jobs/sec but missed enqueue p99 <5 ms, dequeue p99 <10 ms and queue-to-handler
p99 <100 ms. No thresholds were relaxed and no fresh performance or hosted
provider claim is made. Python/provider, broad load and production acceptance
were not rerun for this shared-only integration.
