# PHASE_10

## Phase goal
Ship production readiness gates: resilience, observability, performance thresholds, and full integration matrix.

## In scope / Out of scope
In scope:
- Timeout/retry defaults and configuration for external adapters.
- Structured logging and redaction enforcement.
- Benchmark/performance gates.
- End-to-end integration matrix across adapters and DataFn bridge.

Out of scope:
- Additional new features beyond specified rewrite scope.

## Deliverables
- `searchfn/adapters/src/internal/retry.ts` (new)
- `searchfn/adapters/src/internal/errors.ts` (new)
- `searchfn/adapters/src/internal/redaction.ts` (new)
- `searchfn/adapters/benchmarks/*.ts` (new/updated)
- `searchfn/adapters/scripts/run-integration-matrix.mjs` (new)
- `searchfn/adapters/vitest.integration.config.ts` (new)
- `searchfn/adapters/__tests__/integration/*.test.ts` (new)
- `searchfn/adapters/__tests__/redaction.test.ts` (new)
- `searchfn/adapters/__tests__/retry.test.ts` (new)

## Requirements covered
- PRD-001
- PRD-002
- PRD-003
- QA-001

## Implementation tasks
1. Add shared retry/timeout utility and backend-specific retry classification.
2. Add structured logging hooks and redaction helpers used by server and external adapters.
3. Add benchmark scripts with documented thresholds and pass/fail gate.
4. Add full docker-backed integration matrix runner for postgres/meili/elastic/opensearch + datafn-provider.
5. Add CI/local command wrappers for matrix and benchmarks.

## Verification steps
1. `npm --prefix searchfn/adapters test -- __tests__/retry.test.ts __tests__/redaction.test.ts --runInBand`
- Expected: pass.
2. `npm --prefix searchfn/adapters run benchmark`
- Expected: thresholds pass.
3. `npm --prefix searchfn/adapters test -- --config vitest.integration.config.ts --runInBand`
- Expected: full integration matrix passes.
4. `npm --prefix searchfn/server test && npm --prefix searchfn/client test && npm --prefix searchfn/datafn-provider test`
- Expected: all pass with production hardening changes.

## Stop condition
All production readiness gates pass, and SearchFn rewrite is verified as release-ready within this monorepo.
