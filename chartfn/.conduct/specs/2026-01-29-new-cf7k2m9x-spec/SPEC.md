# ChartFn Specification

## Metadata

- **timestamp**: 2026-01-29T12:00:00Z (UTC)
- **agent_name**: unknown-agent
- **model**: unknown
- **launcher**: Cursor
- **workspace path**: /Users/ar/dev
- **project root**: /Users/ar/dev/superfunctions/chartfn
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo**:
  - **git repo**: yes (parent superfunctions repo) or unknown if not available
  - **branch**: as available
  - **commit**: as available
  - **dirty**: as available
- **spec_folder**: 2026-01-29-new-cf7k2m9x-spec
- **spec_type**: new
- **spec_id**: cf7k2m9x
- **input paths**:
  - chartfn/.conduct/chartfn.intent.md

## Overview

ChartFn is a charting abstraction in the superfunctions ecosystem. It provides a unified API (ChartSpec + ChartAdapter) over multiple charting libraries (ECharts, Carbon Charts, Chart.js, etc.). Users describe charts in a single canonical form (ChartSpec) and can switch backends or use multiple backends in the same application without changing application code. Adapters translate ChartSpec to library-specific configuration.

**One-sentence goal**: Unified chart API with pluggable adapters so users can switch or combine chart libraries (ECharts, Carbon, Chart.js) via a single interface.

**Target users**: Developers building dashboards, analytics UIs, or any app that needs charts and wants to avoid vendor lock-in or support multiple chart engines.

**Target environments**: Browser (primary; DOM container). Optional: Node/SSR for export (e.g. toImage) when an adapter supports it.

**Languages/packages**: TypeScript. Core package (chartfn or @chartfn/core); adapter packages (@chartfn/echarts, @chartfn/carbon, @chartfn/chartjs) or subpaths. Optional: React/Svelte bindings.

**Existing systems**: Aligns with superfunctions patterns (plugfn Adapter, datafn storage adapters). Data shape is library-agnostic and can be fed from datafn or any other source.

**Non-goals**: Native mobile rendering; 3D/WebGL-specific abstractions; real-time streaming chart protocol; chart authoring GUI.

**Hard constraints**: Same ChartSpec + same adapter MUST produce deterministic output where the underlying library allows. Invalid ChartSpec MUST NOT be passed to adapters; core MUST validate and return defined errors. Adapters MUST NOT require application code to use library-specific APIs for the common path.

## Glossary

- **ChartSpec**: The canonical, library-agnostic chart description (type, data, axes, theme, interactions). All adapters consume ChartSpec.
- **ChartAdapter**: Interface implemented by each backend. Methods: mount(container, spec), update(spec), dispose; optional: toImage().
- **chartFn**: The main factory function. Accepts config (defaultAdapter, adapters registry) and returns API: render(spec, options?), use(adapterName), registerAdapter(name, adapter).
- **Adapter name**: String identifier for a registered adapter (e.g. "echarts", "carbon", "chartjs"). Used when rendering to select backend.
- **Container**: DOM element (HTMLElement) or a selector/callback that resolves to one; the mount target for a chart instance.
- **Envelope**: Result type for operations that can fail: `{ ok: true, result: T } | { ok: false, error: ChartfnError }`.
- **Passthrough options**: Optional, adapter-specific key on ChartSpec (e.g. echartsOptions) allowing raw library config for escape hatch. Undefined for adapters that do not use it.
- **Determinism**: For identical ChartSpec and adapter, visual output (and toImage() result) MUST be identical when the underlying library is deterministic.

## Goals

1. Provide a single ChartSpec schema and ChartAdapter interface usable by all adapters.
2. Allow switching chart library at config time or per-render without changing ChartSpec.
3. Allow multiple adapters in the same app (e.g. Carbon for design system, ECharts for complex viz).
4. Ship at least ECharts and Carbon Charts adapters; Chart.js as additional adapter.
5. Support optional passthrough for library-specific options.
6. Define errors and failure behavior (invalid spec, unknown adapter, adapter runtime errors).
7. Optional React and Svelte bindings that use the core API.

## Non-goals

- MVP or "bar/line only" subset; full chart type set is in scope.
- Native mobile SDKs or 3D/WebGL abstraction.
- Real-time streaming protocol.
- Chart authoring GUI or visual builder.
- Python implementation (TypeScript-only unless explicitly added later).

## Public API

### Core package (chartfn)

```typescript
// --- Errors ---
export type ChartfnErrorCode =
  | "SPEC_INVALID"      // ChartSpec validation failed
  | "ADAPTER_UNKNOWN"   // Adapter name not registered
  | "ADAPTER_ERROR";    // Adapter threw or returned error

export interface ChartfnError {
  code: ChartfnErrorCode;
  message: string;
  details: { path?: string; adapter?: string; [key: string]: unknown };
}

// --- ChartSpec (canonical chart model) ---
export type ChartType =
  | "bar" | "line" | "area" | "pie" | "scatter" | "donut" | "combo";

export interface ChartSpecData {
  /** Series: array of { name?: string, values: number[] } or equivalent rows */
  series: Array<{ name?: string; values: number[] } | Record<string, unknown>>;
  /** Optional dimension labels (e.g. x-axis categories) */
  dimensions?: string[];
  /** Optional labels for series */
  labels?: string[];
}

export interface ChartSpecOptions {
  title?: string;
  legend?: { show?: boolean; position?: "top" | "bottom" | "left" | "right" };
  axes?: {
    x?: { label?: string; type?: "category" | "linear" };
    y?: { label?: string; type?: "linear" };
  };
  theme?: "light" | "dark" | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChartSpec {
  type: ChartType;
  data: ChartSpecData;
  options?: ChartSpecOptions;
  /** Adapter-specific escape hatch; key per adapter (e.g. echartsOptions) */
  passthrough?: Record<string, unknown>;
}

// --- ChartAdapter interface ---
export interface ChartAdapterHandle {
  update(spec: ChartSpec): void;
  dispose(): void;
  toImage?(options?: { format?: "png" | "svg"; width?: number; height?: number }): Promise<string>;
}

export interface ChartAdapter {
  readonly name: string;
  mount(container: HTMLElement, spec: ChartSpec) => ChartAdapterHandle;
}

// --- chartFn config and API ---
export interface ChartFnConfig {
  defaultAdapter: string;
  adapters?: Record<string, ChartAdapter>;
}

export interface ChartFnAPI {
  render(
    container: HTMLElement | string,
    spec: ChartSpec,
    options?: { adapter?: string }
  ): ChartfnEnvelope<ChartAdapterHandle>;
  use(adapterName: string): ChartAdapter | undefined;
  registerAdapter(name: string, adapter: ChartAdapter): void;
  getDefaultAdapter(): string;
  setDefaultAdapter(name: string): void;
}

export type ChartfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: ChartfnError };

export function chartFn(config: ChartFnConfig): ChartFnAPI;
```

### Validation

- Core MUST validate ChartSpec before calling any adapter. Validation MUST check: type is a known ChartType, data.series is a non-empty array, and any required fields per type. Invalid spec MUST return `{ ok: false, error: { code: "SPEC_INVALID", message, details: { path } } }`.
- If options.adapter is provided to render(), that adapter MUST be registered; otherwise return `{ ok: false, error: { code: "ADAPTER_UNKNOWN", ... } }`. If not provided, use defaultAdapter.
- If adapter.mount() throws, core MUST catch and return `{ ok: false, error: { code: "ADAPTER_ERROR", message, details: { adapter } } }`.

## Data formats / protocol

- **ChartSpec**: JSON-serializable. series MUST be array of objects with at least one numeric array or values field for supported types. Max series length and max data points per series MAY be capped (see Limits).
- **ChartfnEnvelope**: All public methods that can fail return ChartfnEnvelope<T>. Success: `{ ok: true, result }`. Failure: `{ ok: false, error: ChartfnError }`.
- **Adapter handle**: update(spec) and dispose() are synchronous. toImage() is optional and returns Promise<string> (data URL or SVG string).

## Semantics

- **render(container, spec, options?)**: Resolve container to HTMLElement (if string, document.querySelector). Select adapter by options.adapter or defaultAdapter. Validate spec; if invalid, return error envelope. Call adapter.mount(container, spec). Return handle in envelope or error.
- **use(name)**: Return the registered adapter for name, or undefined.
- **registerAdapter(name, adapter)**: Store adapter under name. Overwrites if name exists. Adapter.name MAY differ from registration name; render uses registration name.
- **getDefaultAdapter / setDefaultAdapter**: Get or set the default adapter name used when options.adapter is not provided.
- **Handle.update(spec)**: Update existing chart with new spec. Adapter MUST validate spec (or delegate to core); behavior on invalid spec is adapter-defined (e.g. no-op or throw). Core does not re-validate on update.
- **Handle.dispose()**: Tear down chart and release resources. Idempotent after first call.
- **Handle.toImage?()**: If present, return image (e.g. PNG/SVG) as string. Optional; not all adapters implement.

## Invariants

- **Determinism**: Same ChartSpec + same adapter + same container size (where relevant) MUST yield identical visual output when the underlying library is deterministic. No Date.now(), Math.random(), or non-deterministic APIs in core validation or spec normalization.
- **Idempotent dispose**: Calling dispose() multiple times on the same handle MUST NOT throw.
- **Validation before adapter**: No adapter receives an invalid ChartSpec; core MUST validate first.
- **Adapter isolation**: One mount = one handle; multiple mounts to same container are undefined (adapter may replace or error).

## Security

- No sensitive data in ChartfnError.message in production (e.g. do not echo full spec). details MAY include path for SPEC_INVALID.
- Passthrough options are passed as-is to adapters; sanitization is adapter responsibility. Core does not execute user script.
- Container MUST be same-origin when using toImage() if adapter uses canvas/svg; CORS is outside scope.

## Limits / caps

- **Max series count**: 100 (configurable or fixed; MUST be documented). Specs with series length > limit MUST fail validation with SPEC_INVALID.
- **Max data points per series**: 10_000 (configurable or fixed). Specs exceeding MUST fail validation with SPEC_INVALID.
- **Max ChartSpec JSON size**: 1 MiB. Larger payloads MUST be rejected with SPEC_INVALID.
- Adapters MAY impose lower limits; those are documented per adapter.

## Observability

- **MUST log**: Adapter registration (name), render start (adapter name, spec type). Level: debug or configurable.
- **MUST NOT log**: Full series data in production (may contain PII). Error details MAY be logged with path/code only.
- **MAY emit**: Optional event/callback on render success/failure for instrumentation. Not required by this spec.

## Compatibility / versioning

- ChartSpec version: v1. Future breaking changes to ChartSpec MUST use a new version field and support at least one prior version during deprecation.
- Adapter interface: ChartAdapter and ChartAdapterHandle are stable; new optional methods (e.g. toImage) are additive. Adapters that do not implement optional methods are valid.
- Package versioning: Semver. Major bump for breaking ChartSpec or ChartFnAPI changes.

## Undefined / explicitly user-deferred only

- Python implementation.
- React/Svelte binding API surface (optional; if deferred, requirements still exist but phase order may put them later).
- Specific theme tokens beyond "light" | "dark".
- Animation configuration in ChartSpec (adapter may use passthrough).
- Real-time update frequency or throttling.
