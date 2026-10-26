# PHASE_04: Chart.js adapter and limits enforcement

## Phase goal

Implement Chart.js adapter and ensure core validation enforces max series (100), max data points per series (10_000), and max ChartSpec JSON size (1 MiB). Limits should already be in Phase 00; this phase adds Chart.js adapter and confirms limit tests pass.

## In scope

- Chart.js adapter: ChartAdapter implementation, map ChartSpec to Chart.js config, mount/update/dispose
- Confirm LIMIT-001 is enforced in validateChartSpec() (Phase 00); add or run tests TV-LIMIT-SERIES-001, TV-LIMIT-POINTS-001, TV-LIMIT-SIZE-001
- Tests: TV-CHARTJS-001

## Out of scope

- Changing limit values (fixed per spec)

## Deliverables

- `adapters/chartjs.ts` or `packages/chartjs/src/index.ts` – Chart.js ChartAdapter
- Tests for Chart.js adapter (TV-CHARTJS-001)
- Verification that limit tests (TV-LIMIT-*) pass against current validation

## Requirements covered

- ADAPT-003, LIMIT-001 (verification)

## Implementation tasks

1. Add chart.js as dependency.
2. Implement Chart.js adapter: mount(container, spec) – new Chart(container, config), config built from ChartSpec (type, data.series, options); return { update(spec2), dispose() { chart.destroy(); } }.
3. Map ChartType to Chart.js chart type (bar, line, pie, etc.).
4. Write test TV-CHARTJS-001.
5. Run or add tests TV-LIMIT-SERIES-001, TV-LIMIT-POINTS-001, TV-LIMIT-SIZE-001; fix validation if any limit is not enforced.

## Verification steps

- npm test: all limit tests and Chart.js adapter test pass.
- Manual: render bar with Chart.js adapter; update and dispose.

## Stop condition

- Chart.js adapter passes TV-CHARTJS-001; all three limit test vectors pass; no regression in earlier phases.
