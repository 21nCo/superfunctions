# PHASE_05: Handle lifecycle and passthrough

## Phase goal

Ensure handle.update(spec) and handle.dispose() behave correctly across adapters; support passthrough options in ChartSpec; ensure core uses no non-deterministic APIs (Date.now(), Math.random()).

## In scope

- Handle update: after mount, update(spec) updates chart without remounting; adapters implement update correctly
- Handle dispose: idempotent; second dispose() does not throw
- ChartSpec.passthrough: optional; core does not validate; adapters (ECharts at least) read adapter-specific keys and merge
- Determinism: audit core (validate, chartFn, render) for Date.now(), Math.random(); remove or document

## Out of scope

- toImage; React/Svelte bindings

## Deliverables

- Adapter implementations (ECharts, Carbon, Chart.js) updated so update() and dispose() are correct and dispose is idempotent
- ChartSpec type includes passthrough?: Record<string, unknown>; validation ignores passthrough
- ECharts adapter (and others as needed) merge passthrough.echartsOptions (or equivalent) with generated option
- Core codebase free of Date.now()/Math.random() in validation and render path
- Tests: TV-HANDLE-UPDATE-001, TV-HANDLE-DISPOSE-001, TV-PASSTHROUGH-001, TV-DETERM-001

## Requirements covered

- API-007, SPEC-001, DETERM-001

## Implementation tasks

1. Verify all adapters: handle.update(spec) calls library update API (setOption, update props, etc.) without remounting; handle.dispose() tears down and is idempotent (guard with flag or no-op after first call).
2. Add passthrough?: Record<string, unknown> to ChartSpec type; ensure validateChartSpec() does not fail on passthrough; do not validate passthrough content.
3. In ECharts adapter (and document for Carbon/Chart.js): read spec.passthrough?.echartsOptions (or adapter-specific key) and merge with generated option.
4. Grep core for Date.now(), Math.random(); remove or confine to non-spec paths; document that validation and render are deterministic.
5. Write tests: TV-HANDLE-UPDATE-001 (mount, update, assert chart changed), TV-HANDLE-DISPOSE-001 (dispose twice, no throw), TV-PASSTHROUGH-001 (spec with passthrough, ECharts uses it), TV-DETERM-001 (two renders same spec/adapter, compare structure or toImage if available).

## Verification steps

- Run all tests; TV-HANDLE-*, TV-PASSTHROUGH-001, TV-DETERM-001 pass.
- No Date.now()/Math.random() in src/validate.ts and src/chart-fn.ts (or equivalent).

## Stop condition

- All lifecycle and passthrough tests pass; determinism requirement met; no regression in earlier phases.
