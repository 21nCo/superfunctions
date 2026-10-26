# ChartFn Implementation Plan

## Architecture sketch

- **chartfn (core)**: Types (ChartSpec, ChartAdapter, ChartfnError, ChartfnEnvelope), validateChartSpec(), chartFn(config) → ChartFnAPI. No chart library dependencies.
- **Adapters**: Separate packages or subpaths: echarts, carbon, chartjs. Each implements ChartAdapter; translates ChartSpec to library config; mounts in container; returns handle with update/dispose and optional toImage.
- **Bindings (optional)**: React and Svelte packages that import core and optionally an adapter; expose hook/component that calls chartFn().render() and dispose() on unmount/destroy.

## Dependency graph

- Phase 00 (types + validation) has no dependencies on adapters.
- Phase 01 (chartFn + render) depends on Phase 00; uses mock adapter.
- Phases 02, 03, 04 (ECharts, Carbon, Chart.js) depend on Phase 01; no dependency on each other.
- Phase 05 (update/dispose, passthrough, determinism) depends on Phase 01 and at least one real adapter (02 or 03).
- Phase 06 (toImage, ADAPTER_ERROR) depends on Phase 01 and adapters that can implement toImage.
- Phases 07, 08 (React, Svelte) depend on Phase 01 and at least one adapter.
- Phase 09 (observability, versioning) depends on Phase 01; can run in parallel with 02–08.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|-----|----------------------|---------------|
| 00 | Core types and validation | ChartSpec, ChartfnError, validateChartSpec(), limits | Unit tests for validation and limits |
| 01 | chartFn API and render | chartFn(), render(), registerAdapter, use, defaultAdapter, envelope | Tests: config, render, envelope, valid-before-adapter, adapter interface |
| 02 | ECharts adapter | @chartfn/echarts or chartfn/echarts implementing ChartAdapter | TV-ECHARTS-001, TV-ECHARTS-002 |
| 03 | Carbon adapter | Carbon adapter implementing ChartAdapter | TV-CARBON-001, TV-CARBON-002 |
| 04 | Chart.js adapter + limits | Chart.js adapter; validation enforces max series, points, size | TV-CHARTJS-001, TV-LIMIT-* |
| 05 | Handle lifecycle and passthrough | update/dispose idempotency; passthrough in spec; no randomness in core | TV-HANDLE-*, TV-PASSTHROUGH-001, TV-DETERM-001 |
| 06 | toImage and ADAPTER_ERROR | Optional toImage on handle; render catches adapter throw → ADAPTER_ERROR | TV-TOIMAGE-001, TV-ENVELOPE-003 |
| 07 | React binding | useChart or <Chart /> using core, dispose on unmount | TV-REACT-001 |
| 08 | Svelte binding | Chart component or action, dispose on destroy | TV-SVELTE-001 |
| 09 | Observability and versioning | Logging rules; versioning doc | TV-OBS-001, COMPAT-001 docs |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented.
2. All verification steps (tests or manual steps) for that phase pass.
3. No regressions in previous phases (full test suite passes).
4. Phase report (if required) is written in the spec folder.
