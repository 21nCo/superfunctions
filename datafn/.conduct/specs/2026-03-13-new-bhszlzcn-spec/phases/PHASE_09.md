# PHASE_09

## Phase goal
Harden performance and latency behavior for ACL-heavy workloads.

## In scope / Out of scope
In scope:
- Ensure index usage and query planning checks.
- Add bounded pull k-way merge implementation.
- Add actor/principal-aware websocket targeting where transport supports it.

Out of scope:
- Migration cutover.

## Deliverables
- `datafn/server/src/execution/sync/pull.ts`
- `datafn/server/src/ws.ts`
- `datafn/server/src/execution/query/pushdown.ts`
- `datafn/server/src/__tests__/performance/spv2-perf-smoke.test.ts` (new)
- `datafn/.conduct/benchmarks/spv2-benchmark-plan.md` (new)

## Requirements covered
- PERF-001
- PERF-002
- PERF-003

## Implementation tasks
1. Enforce index presence assertions in startup diagnostics or migration checks.
2. Replace pull flatten/sort with bounded merge implementation.
3. Add websocket targeted invalidation path and degraded fallback marker.
4. Add performance smoke tests and benchmark plan.

## Verification steps
1. `npm test --workspace datafn/server -- spv2-perf-smoke`
Expected outcome: smoke tests pass.
2. Manual benchmark run following `spv2-benchmark-plan.md`.
Expected outcome: bounded memory and acceptable p95.

## Stop condition
Performance smoke targets pass and no unbounded pull assembly path remains.
