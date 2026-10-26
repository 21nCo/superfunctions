# ChartFn Intent

## One-sentence goal

ChartFn is a charting abstraction in the superfunctions ecosystem that provides a unified API over existing charting libraries (ECharts, Carbon Charts, Chart.js, etc.), allowing users to switch between chart library backends or use multiple backends in the same application without rewriting chart code.

## Scope

1. **Unified API**: A single canonical chart model (ChartSpec) and a single rendering interface (ChartAdapter). Application code describes charts in ChartSpec; adapters translate to library-specific configs.

2. **Interface + Adapters**: Every backend implements the ChartAdapter interface. Core package defines ChartSpec and ChartAdapter; separate adapter packages (or subpaths) implement for ECharts, Carbon Charts, Chart.js.

3. **Switch or use multiple**: User configures default adapter and/or registers multiple adapters by name. At render time, user can specify which adapter to use or let the default apply. Same app can render some charts with Carbon (design system) and others with ECharts (heavy viz).

4. **Chart types**: Support a defined set of chart types (bar, line, area, pie, scatter, and any others specified) via ChartSpec. Type is part of the spec; adapters map to library equivalents.

5. **Data shape**: ChartSpec includes data (series, dimensions, labels) in a format that is library-agnostic and compatible with typical data sources (e.g. datafn query output). No binding to a specific data layer—just a clear contract.

6. **Adapter contract**: ChartAdapter must support: mount(container, spec) returning a dispose function (or handle), and update(spec) for existing chart. Optional: toImage() or similar for export/SSR. Adapters MUST NOT require application code to use library-specific APIs for the common path.

7. **Escape hatch**: ChartSpec MAY include optional passthrough/native options per adapter (e.g. echartsOptions) so that advanced use cases can pass library-specific config without leaving ChartFn.

8. **Determinism**: For the same ChartSpec and same adapter, output MUST be deterministic where the underlying library allows (e.g. for toImage or server-side render).

9. **Errors**: Invalid ChartSpec MUST produce a defined error (code + message). Missing or unknown adapter name MUST produce a defined error. Adapter runtime errors MUST be surfaced with a defined envelope.

10. **Packaging**: Follow superfunctions conventions: initFunction chartFn, namespace chartfn. Package structure: core types + API in main package; adapters as separate packages (@chartfn/echarts, @chartfn/carbon, @chartfn/chartjs) or as subpaths (chartfn/echarts, chartfn/carbon). Single package with adapters as optional peer/imports is acceptable.

11. **Environments**: Primary target is browser (DOM container). Optional: Node/SSR for toImage or headless render if an adapter supports it. No requirement for React/Vue/Svelte in core; framework bindings are optional.

12. **Framework bindings (optional)**: Optional React and/or Svelte bindings (hooks or components) that use the core chartFn() API so that framework users get a drop-in experience. In scope but not required for first delivery if phased; if phased, they must be specified and have requirements.

13. **Adapters to implement**: At least ECharts and Carbon Charts as first-class adapters. Chart.js as additional adapter. Each adapter MUST be fully tested against the ChartSpec contract.

14. **No MVP subset**: Full scope above is in scope. No "phase 1 = bar/line only" unless explicitly deferred by user. Priorities (P0/P1/P2) may indicate sequencing only.

15. **Integration with superfunctions**: Align with patterns used in plugfn (Adapter interface), datafn (storage adapters). Naming and style consistent with existing *fn packages.

16. **Observability**: Logging/events: what is logged or emitted MUST be specified; what MUST NOT be logged (e.g. raw data in production) MUST be specified.

17. **Versioning**: Adapter capability or ChartSpec version MUST be defined so that future evolution does not break existing call sites; compatibility strategy MUST be stated.

18. **Limits**: Max payload size for ChartSpec, max series count, or other caps MUST be defined where relevant to prevent abuse or OOM.
