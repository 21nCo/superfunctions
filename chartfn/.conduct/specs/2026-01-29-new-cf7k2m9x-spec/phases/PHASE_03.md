# PHASE_03: Carbon adapter

## Phase goal

Implement a Carbon Charts adapter that implements ChartAdapter: maps ChartSpec to Carbon chart props, mounts Carbon chart in container, returns handle with update() and dispose().

## In scope

- Carbon adapter package or subpath (e.g. `adapters/carbon.ts` or `@chartfn/carbon`)
- Map ChartSpec to Carbon chart component props (bar, line, etc.)
- mount(container, spec) → render Carbon chart into container, return handle with update and dispose
- Carbon Charts may require React; if so, use ReactDOM.render or createRoot to mount into container and hold ref for update/dispose

## Out of scope

- ECharts or Chart.js; React binding package (Phase 07)

## Deliverables

- `adapters/carbon.ts` or `packages/carbon/src/index.ts` – Carbon ChartAdapter implementation
- Mapping from ChartSpec to Carbon chart type and data props
- update(spec) and dispose() implemented
- Tests: TV-CARBON-001, TV-CARBON-002

## Requirements covered

- ADAPT-002

## Implementation tasks

1. Add Carbon Charts (and React if required) as dependencies.
2. Implement adapter: mount(container, spec) – create Carbon chart (e.g. BarChart) with props derived from spec, mount into container, store instance/root for update and dispose.
3. update(spec): update props and re-render or call Carbon update API if available.
4. dispose(): unmount React root or destroy Carbon instance.
5. Write tests: TV-CARBON-001, TV-CARBON-002 (may require React testing env).
6. Document Carbon-specific passthrough keys if any.

## Verification steps

- Run Carbon adapter tests.
- Manual: render bar chart with Carbon adapter; update and dispose.

## Stop condition

- Carbon adapter passes TV-CARBON-001 and TV-CARBON-002; Phases 00–01 tests still pass.
