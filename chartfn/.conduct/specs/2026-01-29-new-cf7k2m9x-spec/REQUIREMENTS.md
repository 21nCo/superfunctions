# ChartFn Requirements

## Table of Contents

### P0 (Core)

- API-001: chartFn factory and config
- API-002: ChartSpec schema and validation
- API-003: ChartAdapter interface
- API-004: render() with adapter selection
- API-005: Envelope and error codes
- ADAPT-001: ECharts adapter
- ADAPT-002: Carbon adapter
- VALID-001: Spec validation before adapter
- LIMIT-001: Series and payload limits

### P1 (Adapters and escape hatch)

- ADAPT-003: Chart.js adapter
- API-006: registerAdapter / use / defaultAdapter
- API-007: Handle update and dispose
- SPEC-001: Passthrough options
- DETERM-001: Determinism

### P2 (Export and bindings)

- API-008: toImage optional
- BIND-001: React binding (optional)
- BIND-002: Svelte binding (optional)
- OBS-001: Logging rules
- COMPAT-001: Versioning

---

## P0 Requirements

### API-001: chartFn factory and config

**Priority**: P0  
**Statement**: The core package MUST export a function `chartFn(config: ChartFnConfig): ChartFnAPI` where ChartFnConfig includes `defaultAdapter: string` and optional `adapters?: Record<string, ChartAdapter>`.  
**Rationale**: Entry point and configuration are required for all use cases.  
**Acceptance criteria**:
- Calling chartFn({ defaultAdapter: "echarts", adapters: { echarts: echartsAdapter } }) returns an object with render, use, registerAdapter, getDefaultAdapter, setDefaultAdapter.
- getDefaultAdapter() returns the configured defaultAdapter.
- setDefaultAdapter(name) updates the default; getDefaultAdapter() reflects it.
**Test vectors**: TV-API-CONFIG-001, TV-API-CONFIG-002  
**Notes**: If adapters is empty and defaultAdapter is set, render will fail with ADAPTER_UNKNOWN until an adapter is registered.

---

### API-002: ChartSpec schema and validation

**Priority**: P0  
**Statement**: The core MUST define ChartSpec with type (ChartType), data (ChartSpecData with series), and optional options. Validation MUST reject missing type, missing or empty data.series, and unknown ChartType.  
**Rationale**: Canonical chart model and validation prevent invalid data from reaching adapters.  
**Acceptance criteria**:
- Valid spec: { type: "bar", data: { series: [{ name: "A", values: [1,2,3] }] } } passes validation.
- Invalid: missing type, empty series, type "unknown" → SPEC_INVALID with path in details.
**Test vectors**: TV-SPEC-VALID-001, TV-SPEC-INVALID-001, TV-SPEC-INVALID-002, TV-SPEC-INVALID-003  
**Notes**: dimensions and labels are optional; validation does not require them.

---

### API-003: ChartAdapter interface

**Priority**: P0  
**Statement**: ChartAdapter MUST have a readonly `name: string` and a method `mount(container: HTMLElement, spec: ChartSpec): ChartAdapterHandle`. ChartAdapterHandle MUST have `update(spec: ChartSpec): void` and `dispose(): void`.  
**Rationale**: All backends implement the same contract so that render() can be backend-agnostic.  
**Acceptance criteria**:
- Any object with name and mount(container, spec) returning { update, dispose } is a valid ChartAdapter.
- mount is called with validated ChartSpec only (enforced by core).
**Test vectors**: TV-ADAPTER-INTERFACE-001  
**Notes**: toImage on handle is optional.

---

### API-004: render() with adapter selection

**Priority**: P0  
**Statement**: ChartFnAPI.render(container, spec, options?) MUST resolve container to HTMLElement (if string, use document.querySelector), validate spec, select adapter by options?.adapter or defaultAdapter, call adapter.mount(container, spec), and return ChartfnEnvelope<ChartAdapterHandle>.  
**Rationale**: Primary use case is rendering a chart with optional adapter override.  
**Acceptance criteria**:
- render(div, validSpec) returns { ok: true, result: handle } when defaultAdapter is registered and spec is valid.
- render(div, validSpec, { adapter: "carbon" }) uses carbon adapter when registered.
- render(div, invalidSpec) returns { ok: false, error: { code: "SPEC_INVALID" } }.
- render(div, validSpec, { adapter: "nonexistent" }) returns { ok: false, error: { code: "ADAPTER_UNKNOWN" } }.
**Test vectors**: TV-RENDER-001, TV-RENDER-002, TV-RENDER-003, TV-RENDER-004  
**Notes**: Container resolution failure (e.g. invalid selector) is undefined or adapter-specific; spec allows returning ADAPTER_ERROR or a dedicated error code if documented.

---

### API-005: Envelope and error codes

**Priority**: P0  
**Statement**: The render operation MUST return ChartfnEnvelope<ChartAdapterHandle>. Standalone validation MUST return its declared success/error envelope. Imperative adapter handles retain the API-003/API-007 void update/dispose signatures and API-008 Promise<string> export signature; failures from those methods throw or reject. Error branch MUST use ChartfnError with code: SPEC_INVALID | ADAPTER_UNKNOWN | ADAPTER_ERROR, message string, and details object (path, adapter, etc. as applicable).  
**Rationale**: Consistent error handling and machine-readable codes.  
**Acceptance criteria**:
- SPEC_INVALID: validation failure; details.path present when applicable.
- ADAPTER_UNKNOWN: adapter name not registered; details.adapter present.
- ADAPTER_ERROR: adapter threw or failed; details.adapter present.
**Test vectors**: TV-ENVELOPE-001, TV-ENVELOPE-002, TV-ENVELOPE-003  
**Notes**: None.

---

### ADAPT-001: ECharts adapter

**Priority**: P0  
**Statement**: An ECharts adapter MUST be provided (in core package or @chartfn/echarts) that implements ChartAdapter, maps ChartSpec to ECharts option, and mounts an ECharts instance in the container.  
**Rationale**: ECharts is a primary target library per intent.  
**Acceptance criteria**:
- Adapter implements ChartAdapter; mount returns handle with update and dispose.
- For type "bar" and valid series, chart renders in container (visual or DOM structure check).
- update(spec) updates the chart; dispose() removes it.
**Test vectors**: TV-ECHARTS-001, TV-ECHARTS-002  
**Notes**: Passthrough echartsOptions may be supported.

---

### ADAPT-002: Carbon adapter

**Priority**: P0  
**Statement**: A Carbon Charts adapter MUST be provided (in core package or @chartfn/carbon) that implements ChartAdapter, maps ChartSpec to Carbon props, and mounts a Carbon chart in the container.  
**Rationale**: Carbon is a primary target for design-system alignment.  
**Acceptance criteria**:
- Adapter implements ChartAdapter; mount returns handle with update and dispose.
- For type "bar" and valid series, chart renders in container.
- update(spec) and dispose() behave as specified.
**Test vectors**: TV-CARBON-001, TV-CARBON-002  
**Notes**: Carbon chart types may differ slightly; mapping from ChartType to Carbon type is adapter responsibility.

---

### VALID-001: Spec validation before adapter

**Priority**: P0  
**Statement**: Core MUST validate ChartSpec before calling any adapter.mount(). Invalid spec MUST NOT be passed to adapters.  
**Rationale**: Prevents adapter-specific errors for contract violations.  
**Acceptance criteria**:
- Any path that calls adapter.mount() is preceded by successful validation.
- Invalid spec always yields SPEC_INVALID envelope from render().
**Test vectors**: TV-VALID-BEFORE-ADAPTER-001  
**Notes**: Adapter may still validate for its own constraints; core guarantees type/data shape.

---

### LIMIT-001: Series and payload limits

**Priority**: P0  
**Statement**: Core validation MUST enforce max series count (100), max data points per series (10_000), and max ChartSpec JSON size (1 MiB). Specs exceeding any limit MUST fail with SPEC_INVALID and path/details indicating the limit.  
**Rationale**: Prevents abuse and OOM.  
**Acceptance criteria**:
- series.length > 100 → SPEC_INVALID.
- Any series with values.length > 10_000 → SPEC_INVALID.
- JSON.stringify(spec) length > 1_048_576 → SPEC_INVALID.
**Test vectors**: TV-LIMIT-SERIES-001, TV-LIMIT-POINTS-001, TV-LIMIT-SIZE-001  
**Notes**: Limits may be configurable in ChartFnConfig in a future revision; for v1 they are fixed and documented.

---

## P1 Requirements

### ADAPT-003: Chart.js adapter

**Priority**: P1  
**Statement**: A Chart.js adapter MUST be provided that implements ChartAdapter and maps ChartSpec to Chart.js config.  
**Rationale**: Intent requires Chart.js as additional adapter.  
**Acceptance criteria**:
- Implements ChartAdapter; mount/update/dispose work.
- Bar and line types render correctly for valid spec.
**Test vectors**: TV-CHARTJS-001  
**Notes**: None.

---

### API-006: registerAdapter / use / defaultAdapter

**Priority**: P1  
**Statement**: ChartFnAPI MUST provide registerAdapter(name, adapter), use(name) returning ChartAdapter | undefined, getDefaultAdapter(), and setDefaultAdapter(name).  
**Rationale**: Multiple adapters and runtime registration are required.  
**Acceptance criteria**:
- registerAdapter("custom", adapter) then use("custom") returns that adapter.
- use("missing") returns undefined.
- setDefaultAdapter("carbon"); getDefaultAdapter() === "carbon".
**Test vectors**: TV-REGISTER-001, TV-USE-001  
**Notes**: Already partially covered by API-001; this makes register/use explicit.

---

### API-007: Handle update and dispose

**Priority**: P1  
**Statement**: ChartAdapterHandle.update(spec) MUST update the chart with the new spec. ChartAdapterHandle.dispose() MUST tear down the chart and MUST be idempotent.  
**Rationale**: Lifecycle and updates are core to dynamic charts.  
**Acceptance criteria**:
- After mount, calling handle.update(newSpec) updates the chart (no new mount).
- Calling handle.dispose() removes the chart; second dispose() does not throw.
**Test vectors**: TV-HANDLE-UPDATE-001, TV-HANDLE-DISPOSE-001  
**Notes**: Core does not re-validate spec on update; adapter may validate.

---

### SPEC-001: Passthrough options

**Priority**: P1  
**Statement**: ChartSpec MAY include an optional `passthrough?: Record<string, unknown>`. Adapters MAY read adapter-specific keys (e.g. echartsOptions) and merge with generated config. Core MUST NOT validate passthrough content.  
**Rationale**: Escape hatch for library-specific options.  
**Acceptance criteria**:
- Spec with passthrough: { echartsOptions: { ... } } is valid; ECharts adapter may use it.
- Core validation does not fail on unknown top-level keys in passthrough.
**Test vectors**: TV-PASSTHROUGH-001  
**Notes**: Adapter documents which keys it uses.

---

### DETERM-001: Determinism

**Priority**: P1  
**Statement**: For the same ChartSpec and same adapter, output MUST be deterministic where the underlying library allows. Core MUST NOT use Date.now(), Math.random(), or other non-deterministic sources in validation or spec normalization.  
**Rationale**: Required for toImage, SSR, and reproducible tests.  
**Acceptance criteria**:
- Two render() calls with same container (or two containers), same spec, same adapter produce equivalent DOM/config (modulo library internals). No randomness in core.
**Test vectors**: TV-DETERM-001  
**Notes**: Library may have animations; "deterministic" applies to final state or when animations disabled via passthrough.

---

## P2 Requirements

### API-008: toImage optional

**Priority**: P2  
**Statement**: ChartAdapterHandle MAY expose toImage?(options?: { format?: "png"|"svg"; width?: number; height?: number }): Promise<string>. If present, it MUST return a string (data URL or SVG). Core does not require adapters to implement toImage.  
**Rationale**: Export and SSR use cases.  
**Acceptance criteria**:
- If handle.toImage exists, calling it returns a Promise that resolves to a string.
- Adapters that do not implement toImage are valid.
**Test vectors**: TV-TOIMAGE-001  
**Notes**: None.

---

### BIND-001: React binding (optional)

**Priority**: P2  
**Statement**: An optional React binding (hook or component) MUST use the core chartFn() API to render charts. It MUST accept ChartSpec and optional adapter name and MUST clean up on unmount (dispose).  
**Rationale**: Framework users get drop-in experience.  
**Acceptance criteria**:
- A hook useChart(containerRef, spec, options?) or component <Chart spec={spec} adapter="echarts" /> renders and disposes correctly.
- Unmount calls handle.dispose().
**Test vectors**: TV-REACT-001  
**Notes**: Package may be @chartfn/react or chartfn/react.

---

### BIND-002: Svelte binding (optional)

**Priority**: P2  
**Statement**: An optional Svelte binding (component or action) MUST use the core chartFn() API and MUST clean up on destroy (dispose).  
**Rationale**: Svelte is used in superfunctions (e.g. docsfn, datafn/svelte).  
**Acceptance criteria**:
- A component or action accepts spec and optional adapter; renders and disposes on destroy.
**Test vectors**: TV-SVELTE-001  
**Notes**: Package may be @chartfn/svelte or chartfn/svelte.

---

### OBS-001: Logging rules

**Priority**: P2  
**Statement**: Implementation MUST NOT log full series data in production. Implementation MAY log adapter name, spec type, and error code/path at debug level.  
**Rationale**: Observability without PII leakage.  
**Acceptance criteria**:
- No log line contains full data.series in default production config.
- Adapter registration and render (adapter name, type) may be logged at debug.
**Test vectors**: TV-OBS-001 (manual or audit).  
**Notes**: None.

---

### COMPAT-001: Versioning

**Priority**: P2  
**Statement**: ChartSpec MUST have a documented stability policy: v1 is stable; breaking changes require a version field and deprecation period. Adapter interface additions MUST be additive (optional methods).  
**Rationale**: Compatibility and upgrade path.  
**Acceptance criteria**:
- SPEC.md or README documents ChartSpec version and adapter interface stability.
- New optional methods on ChartAdapter/Handle do not break existing adapters.
**Test vectors**: Documentation audit.  
**Notes**: None.
