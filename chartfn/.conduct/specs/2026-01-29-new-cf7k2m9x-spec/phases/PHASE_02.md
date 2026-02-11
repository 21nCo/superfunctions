# PHASE_02: ECharts adapter

## Phase goal

Implement an ECharts adapter that implements ChartAdapter: maps ChartSpec to ECharts option, mounts ECharts instance in container, returns handle with update() and dispose().

## In scope

- ECharts adapter package or subpath (e.g. `adapters/echarts.ts` or `@chartfn/echarts`)
- Map ChartSpec (bar, line, area, pie, scatter, donut) to ECharts option
- mount(container, spec) → create ECharts instance, setOption, return { update(spec), dispose() }
- Optional: read passthrough.echartsOptions and merge with generated option

## Out of scope

- Carbon or Chart.js adapters; React/Svelte bindings

## Deliverables

- `adapters/echarts.ts` or `packages/echarts/src/index.ts` – ECharts ChartAdapter implementation
- Map ChartSpec.data.series and options (axes, legend, theme) to echarts option
- Handle update(spec): setOption with new spec
- Handle dispose(): echartsInstance.dispose()
- `__tests__/echarts-adapter.test.ts` or equivalent – tests in browser or jsdom with canvas mock if needed

## Requirements covered

- ADAPT-001

## Implementation tasks

1. Add ECharts as dependency (e.g. echarts) in adapter package or root.
2. Implement adapter.name = "echarts" (or registration name); adapter.mount(container, spec): create echarts.init(container), build option from spec (type, data.series, options.axes, options.legend, options.theme), apply passthrough.echartsOptions if present, setOption(option), return { update(spec2) { setOption(buildOption(spec2)); }, dispose() { instance.dispose(); } }.
3. Implement bar and line at minimum; extend to area, pie, scatter, donut as needed.
4. Write tests: TV-ECHARTS-001 (mount and render bar), TV-ECHARTS-002 (update and double dispose).
5. Document any ECharts-specific passthrough keys in README or adapter file.

## Verification steps

- Run adapter tests (may require DOM environment: jsdom or browser).
- Manually: create div, chartFn({ defaultAdapter: "echarts", adapters: { echarts: echartsAdapter } }), render(div, barSpec), verify chart appears; call update and dispose.

## Stop condition

- ECharts adapter passes TV-ECHARTS-001 and TV-ECHARTS-002; no regression in Phase 00/01 tests.
