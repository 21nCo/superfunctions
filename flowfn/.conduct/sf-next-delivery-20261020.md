# FlowFn sf-next delivery preparation

The isolated branch starts at shared prerequisite 9b841ff4a. FlowFn changes are
ported from committed source 688dbd7f4 only. The source's original next baseline
523c66ae8 and the target shared head have identical FlowFn trees, so no newer
target implementation was overwritten. Original target README, SPEC, intent,
Python STATUS and existing .conduct planning documents remain; their historical
completion claims do not establish current readiness. Source-worktree dirty root
files and untracked documents were not copied.

The port includes TypeScript/Python queue, stream and workflow durability,
ownership/fencing, lifecycle/cancellation, scheduler, telemetry, health, runtime
admin surfaces, documentation and regressions. Tracked generated Python egg-info
was removed under the existing ignore rule. A trailing blank line was normalized.

The target already registers FlowFn core/admin workspaces. Core HTTP dependency
now uses the shared 0.3.1 package. A fresh target lock was generated using npm11;
source root lock was not used. Common-path lock version updates are upgrades for
FlowFn's Vitest4, PostgreSQL/Drizzle and related build dependency resolution;
root manifest remains unchanged.

## Target-local validation

- npm10 clean scoped ci: 487 packages, no temporary dependency symlinks.
- Observability, HTTP, MCP and shared admin prerequisites build.
- FlowFn core CJS/ESM/declarations and admin build.
- Core source and test TypeScript checks pass.
- Core: 157 passed, 59 native-provider skips; admin: 15 passed.
- Python3.9 source: 89 passed, 94 provider/environment skips.
- Fresh Python3.12 wheel: 89 passed, 94 skips, site-packages import verified from
  an isolated temporary directory outside the checkout.
- Strict mypy1.18.2 on Python3.9: all47 source files pass.

Installation emitted unrelated workspace Node22 engine warnings on Node20.20.0
and the existing cron-parser4 deprecation. Python Pydantic configuration and
setuptools metadata deprecations remain. These checks do not establish the full
Node floor/version matrix or packed npm consumers on this target.

## Remaining original gates

Native Docker runtime was unavailable during the preceding checkpoints; no
Redis/PostgreSQL acceptance is newly claimed here. Durable provider restart,
recovery and cross-process trace behavior must be rerun on the final target.
Original D1/SQS/Kafka, stream partitions, persisted policy, SDK parity and workload
performance remain accountable. Prior native queue throughput/latency targets
were not met and have not been remeasured by this port. Cloud/deployment, complete
packed consumers, hosted checks, release and full production readiness are not
established. No push, PR, merge or publication was performed.
