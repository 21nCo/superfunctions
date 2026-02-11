# ChartFn Test Vectors

Golden inputs and expected outputs for requirements. Each vector is independently executable and deterministic.

## Table of Contents

- [API / Config](#api--config)
- [ChartSpec validation](#chartspec-validation)
- [Adapter interface](#adapter-interface)
- [Render](#render)
- [Envelope / errors](#envelope--errors)
- [Adapters (ECharts, Carbon, Chart.js)](#adapters)
- [Validation before adapter](#validation-before-adapter)
- [Limits](#limits)
- [Handle update / dispose](#handle-update--dispose)
- [Passthrough](#passthrough)
- [Determinism](#determinism)
- [toImage](#toimage)
- [React / Svelte](#react--svelte)
- [Observability](#observability)

---

## API / Config

### TV-API-CONFIG-001 (Positive: chartFn returns API with config)

**Input**:
- `chartFn({ defaultAdapter: "echarts", adapters: { echarts: echartsAdapter } })`

**Expected output**:
- Return value has: `render`, `use`, `registerAdapter`, `getDefaultAdapter`, `setDefaultAdapter`
- `getDefaultAdapter()` === `"echarts"`

### TV-API-CONFIG-002 (Positive: setDefaultAdapter updates default)

**Input**:
- Create API with defaultAdapter "echarts"; call `setDefaultAdapter("carbon")`

**Expected output**:
- `getDefaultAdapter()` === `"carbon"`

---

## ChartSpec validation

### TV-SPEC-VALID-001 (Positive: valid bar spec)

**Input** (ChartSpec):
```json
{
  "type": "bar",
  "data": {
    "series": [{ "name": "A", "values": [1, 2, 3] }]
  }
}
```

**Expected output**: Validation passes; render with valid adapter returns `{ ok: true, result: handle }`.

### TV-SPEC-INVALID-001 (Negative: missing type)

**Input** (ChartSpec):
```json
{
  "data": { "series": [{ "name": "A", "values": [1, 2, 3] }] }
}
```

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", message: "...", details: { path: "type" or similar } } }`.

### TV-SPEC-INVALID-002 (Negative: empty series)

**Input** (ChartSpec):
```json
{
  "type": "bar",
  "data": { "series": [] }
}
```

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", message: "...", details: { path: "data.series" or similar } } }`.

### TV-SPEC-INVALID-003 (Negative: unknown ChartType)

**Input** (ChartSpec):
```json
{
  "type": "unknown",
  "data": { "series": [{ "name": "A", "values": [1, 2, 3] }] }
}
```

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", message: "...", details: { path: "type" or similar } } }`.

---

## Adapter interface

### TV-ADAPTER-INTERFACE-001 (Positive: object with name + mount returning handle)

**Input**:
- Object: `{ name: "mock", mount(container, spec) { return { update() {}, dispose() {} }; } }`

**Expected output**: Acceptable as ChartAdapter; registerAdapter("mock", obj) then render(container, validSpec, { adapter: "mock" }) returns `{ ok: true, result }` and result has update and dispose.

---

## Render

### TV-RENDER-001 (Positive: render with default adapter)

**Input**:
- API with defaultAdapter "echarts" and echarts adapter registered; valid container (HTMLElement); valid bar ChartSpec.

**Expected output**: `{ ok: true, result: handle }`; handle has update and dispose; chart is visible in container (DOM or visual check).

### TV-RENDER-002 (Positive: render with explicit adapter)

**Input**:
- API with echarts and carbon registered; defaultAdapter "echarts"; `render(container, validSpec, { adapter: "carbon" })`.

**Expected output**: `{ ok: true, result: handle }`; chart is Carbon (e.g. DOM class or structure).

### TV-RENDER-003 (Negative: invalid spec)

**Input**:
- `render(container, { type: "bar", data: { series: [] } })`.

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", ... } }`.

### TV-RENDER-004 (Negative: unknown adapter name)

**Input**:
- `render(container, validSpec, { adapter: "nonexistent" })` where "nonexistent" is not registered.

**Expected output**: `{ ok: false, error: { code: "ADAPTER_UNKNOWN", message: "...", details: { adapter: "nonexistent" } } }`.

---

## Envelope / errors

### TV-ENVELOPE-001 (SPEC_INVALID shape)

**Input**: Any validation failure (e.g. empty series).

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", message: string, details: object } }`.

### TV-ENVELOPE-002 (ADAPTER_UNKNOWN shape)

**Input**: render with adapter name not registered.

**Expected output**: `{ ok: false, error: { code: "ADAPTER_UNKNOWN", message: string, details: { adapter: string } } }`.

### TV-ENVELOPE-003 (ADAPTER_ERROR shape)

**Input**: Adapter that throws in mount() (e.g. mock that throws).

**Expected output**: `{ ok: false, error: { code: "ADAPTER_ERROR", message: string, details: { adapter: string } } }`.

---

## Adapters

### TV-ECHARTS-001 (Positive: ECharts mount and render)

**Input**: Valid bar ChartSpec; container; ECharts adapter; render(container, spec).

**Expected output**: `{ ok: true, result }`; container contains ECharts canvas or DOM; handle.update(spec2) updates chart; handle.dispose() removes it.

### TV-ECHARTS-002 (Positive: ECharts update and dispose)

**Input**: After TV-ECHARTS-001 mount; call handle.update(newSpec); then handle.dispose(); then handle.dispose() again.

**Expected output**: Chart updates; first dispose() removes chart; second dispose() does not throw.

### TV-CARBON-001 (Positive: Carbon mount and render)

**Input**: Valid bar ChartSpec; container; Carbon adapter; render(container, spec).

**Expected output**: `{ ok: true, result }`; Carbon chart in container; handle has update and dispose.

### TV-CARBON-002 (Positive: Carbon update and dispose)

**Input**: Same as TV-ECHARTS-002 but with Carbon adapter.

**Expected output**: Same behavior (update, idempotent dispose).

### TV-CHARTJS-001 (Positive: Chart.js mount and render)

**Input**: Valid bar ChartSpec; container; Chart.js adapter; render(container, spec).

**Expected output**: `{ ok: true, result }`; Chart.js chart in container; update and dispose work.

---

## Validation before adapter

### TV-VALID-BEFORE-ADAPTER-001 (Negative: invalid spec never reaches adapter)

**Input**: Mock adapter that records mount(spec); render(container, invalidSpec).

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID" } }`; mock adapter mount was NOT called.

---

## Limits

### TV-LIMIT-SERIES-001 (Negative: series count > 100)

**Input**: ChartSpec with data.series length 101 (each series valid).

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", details: { path or limit indicator } } }`.

### TV-LIMIT-POINTS-001 (Negative: data points per series > 10_000)

**Input**: ChartSpec with one series with values length 10_001.

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", ... } }`.

### TV-LIMIT-SIZE-001 (Negative: ChartSpec JSON > 1 MiB)

**Input**: ChartSpec that serializes to more than 1_048_576 bytes (e.g. huge labels array).

**Expected output**: `{ ok: false, error: { code: "SPEC_INVALID", ... } }`.

---

## Handle update / dispose

### TV-HANDLE-UPDATE-001 (Positive: update changes chart)

**Input**: Mount chart; call handle.update(newSpec) with different data.

**Expected output**: Chart content updates (no new mount); no error.

### TV-HANDLE-DISPOSE-001 (Positive: dispose idempotent)

**Input**: Mount chart; handle.dispose(); handle.dispose() again.

**Expected output**: First dispose() tears down chart; second dispose() does not throw.

---

## Passthrough

### TV-PASSTHROUGH-001 (Positive: passthrough accepted and passed to adapter)

**Input**: ChartSpec with `passthrough: { echartsOptions: { animation: false } }`; ECharts adapter that respects echartsOptions.

**Expected output**: Validation passes; render returns success; adapter receives spec with passthrough; chart renders (adapter may disable animation).

---

## Determinism

### TV-DETERM-001 (Positive: same spec + adapter → same result)

**Input**: Same ChartSpec; same adapter; two containers (or same container, mount twice with dispose in between). Compare final DOM or toImage() output (if available).

**Expected output**: No randomness in core; two renders produce equivalent structure (modulo library internals). Core does not use Date.now() or Math.random() in validation.

---

## toImage

### TV-TOIMAGE-001 (Positive: toImage returns string when implemented)

**Input**: Adapter that implements toImage(); mount chart; await handle.toImage({ format: "png" }).

**Expected output**: Promise resolves to string (data URL or SVG). No throw.

---

## React / Svelte

### TV-REACT-001 (Positive: React binding mounts and disposes)

**Input**: Render React component/hook with spec; unmount component.

**Expected output**: Chart appears in container; on unmount, handle.dispose() was called (no leak).

### TV-SVELTE-001 (Positive: Svelte binding mounts and disposes)

**Input**: Render Svelte component with spec; destroy component.

**Expected output**: Chart appears; on destroy, handle.dispose() called.

---

## Observability

### TV-OBS-001 (Negative: full series not logged in production)

**Input**: Configure logging for production; render with spec containing series data; capture logs.

**Expected output**: No log line contains the full data.series array (PII/size). Error logs may contain code and path only.
