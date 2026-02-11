# PHASE_01: chartFn API and render

## Phase goal

Implement ChartAdapter interface, ChartFnConfig, chartFn(config), registerAdapter, use, getDefaultAdapter, setDefaultAdapter, and render(container, spec, options?) that validates spec, selects adapter, and calls adapter.mount(). Use a mock adapter for tests.

## In scope

- ChartAdapter and ChartAdapterHandle types
- chartFn(config): ChartFnAPI
- render(container, spec, options?) → ChartfnEnvelope<ChartAdapterHandle>; resolve container (string → querySelector); validate spec; select adapter by options.adapter or defaultAdapter; call adapter.mount(container, spec); return envelope or catch and return ADAPTER_ERROR
- registerAdapter(name, adapter), use(name), getDefaultAdapter(), setDefaultAdapter(name)
- Mock adapter for tests (implements ChartAdapter, records mount calls)

## Out of scope

- Real ECharts/Carbon/Chart.js adapters

## Deliverables

- `src/adapter.ts` or in types – ChartAdapter, ChartAdapterHandle
- `src/chart-fn.ts` – chartFn(), ChartFnAPI implementation
- `src/resolve-container.ts` or inline – resolve HTMLElement from container (string or HTMLElement)
- `__tests__/chart-fn.test.ts` – tests for config, render, envelope, valid-before-adapter, adapter interface
- `__tests__/mock-adapter.ts` – mock ChartAdapter

## Requirements covered

- API-001, API-003, API-004, API-005, API-006, VALID-001

## Implementation tasks

1. Define ChartAdapter (name, mount(container, spec) => ChartAdapterHandle) and ChartAdapterHandle (update(spec), dispose()) in types.
2. Implement chartFn(config): store defaultAdapter and adapters map; return object with render, use, registerAdapter, getDefaultAdapter, setDefaultAdapter.
3. Implement render(container, spec, options?): resolve container to HTMLElement (if string, document.querySelector); run validateChartSpec(spec); if invalid return error envelope; get adapter by options?.adapter ?? defaultAdapter; if missing return ADAPTER_UNKNOWN; try adapter.mount(container, spec), return { ok: true, result: handle }; catch → { ok: false, error: ADAPTER_ERROR }.
4. Implement registerAdapter(name, adapter), use(name), getDefaultAdapter(), setDefaultAdapter(name).
5. Create mock adapter: mount returns { update() {}, dispose() {} }; optionally record spec for TV-VALID-BEFORE-ADAPTER-001.
6. Write tests: TV-API-CONFIG-001, TV-API-CONFIG-002, TV-ADAPTER-INTERFACE-001, TV-RENDER-001 (with mock), TV-RENDER-002 (two mocks), TV-RENDER-003, TV-RENDER-004, TV-ENVELOPE-001, TV-ENVELOPE-002, TV-ENVELOPE-003 (mock that throws), TV-VALID-BEFORE-ADAPTER-001.

## Verification steps

- `npm test` or `npx vitest run __tests__/chart-fn.test.ts`
- Expected: All tests pass; invalid spec never calls mock mount; unknown adapter returns ADAPTER_UNKNOWN.

## Stop condition

- chartFn() and render() work with mock adapter; all listed test vectors pass; build succeeds.
