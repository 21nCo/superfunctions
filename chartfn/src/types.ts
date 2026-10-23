export type ChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "donut"
  | "combo";

export interface ChartSpecSeries {
  name?: string;
  values: number[];
}

export interface ChartSpecData {
  /** Series: array of { name?: string, values: number[] } or equivalent rows */
  series: Array<ChartSpecSeries | Record<string, unknown>>;
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

export interface ChartAdapterHandle {
  update(spec: ChartSpec): void;
  dispose(): void;
  toImage?(options?: {
    format?: "png" | "svg";
    width?: number;
    height?: number;
  }): Promise<string>;
}

export interface ChartAdapter {
  readonly name: string;
  mount(container: HTMLElement, spec: ChartSpec): ChartAdapterHandle;
}

export interface ChartFnConfig {
  defaultAdapter: string;
  adapters?: Record<string, ChartAdapter>;
}

export interface ChartFnAPI {
  render(
    container: HTMLElement | string,
    spec: ChartSpec,
    options?: { adapter?: string },
  ): ChartfnEnvelope<ChartAdapterHandle>;
  use(adapterName: string): ChartAdapter | undefined;
  registerAdapter(name: string, adapter: ChartAdapter): void;
  getDefaultAdapter(): string;
  setDefaultAdapter(name: string): void;
}

export type ChartfnErrorCode =
  | "SPEC_INVALID"
  | "ADAPTER_UNKNOWN"
  | "ADAPTER_ERROR";

export interface ChartfnError {
  code: ChartfnErrorCode;
  message: string;
  details: { path?: string; adapter?: string; [key: string]: unknown };
}

export type ChartfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: ChartfnError };
