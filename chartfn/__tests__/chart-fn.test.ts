import { beforeEach, describe, expect, it } from "vitest";

import { chartFn } from "../src/chart-fn.js";
import { ChartAdapter, ChartSpec } from "../src/types.js";
import { MockAdapter } from "./mock-adapter.js";

const validSpec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

const invalidSpec = {
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
} as ChartSpec;

const container = { id: "chart" } as unknown as HTMLElement;

beforeEach(() => {
  (globalThis as unknown as { document?: { querySelector: (sel: string) => HTMLElement | null } }).document = {
    querySelector: (sel: string) => (sel === "#chart" ? container : null),
  };
});

describe("chartFn config", () => {
  it("returns API with default adapter", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    expect(api.render).toBeTypeOf("function");
    expect(api.use).toBeTypeOf("function");
    expect(api.registerAdapter).toBeTypeOf("function");
    expect(api.getDefaultAdapter()).toBe("mock");
  });

  it("setDefaultAdapter updates default", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    api.setDefaultAdapter("carbon");
    expect(api.getDefaultAdapter()).toBe("carbon");
  });
});

describe("adapter interface", () => {
  it("accepts a valid ChartAdapter", () => {
    const adapter: ChartAdapter = {
      name: "inline",
      mount: () => ({
        update: () => undefined,
        dispose: () => undefined,
      }),
    };

    const api = chartFn({ defaultAdapter: "inline", adapters: { inline: adapter } });
    const result = api.render(container, validSpec);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.update).toBeTypeOf("function");
      expect(result.result.dispose).toBeTypeOf("function");
    }
  });
});

describe("render", () => {
  it("renders with default adapter", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render(container, validSpec);
    expect(result.ok).toBe(true);
    expect(adapter.mounts).toHaveLength(1);
  });

  it("renders with explicit adapter", () => {
    const echarts = new MockAdapter("echarts");
    const carbon = new MockAdapter("carbon");
    const api = chartFn({
      defaultAdapter: "echarts",
      adapters: { echarts, carbon },
    });

    const result = api.render(container, validSpec, { adapter: "carbon" });
    expect(result.ok).toBe(true);
    expect(carbon.mounts).toHaveLength(1);
    expect(echarts.mounts).toHaveLength(0);
  });

  it("rejects invalid spec", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render(container, invalidSpec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
    }
  });

  it("rejects unknown adapter", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render(container, validSpec, { adapter: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADAPTER_UNKNOWN");
      expect(result.error.details.adapter).toBe("missing");
    }
  });

  it("returns ADAPTER_ERROR when adapter throws", () => {
    const adapter = new MockAdapter("mock");
    adapter.shouldThrow = true;
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render(container, validSpec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADAPTER_ERROR");
      expect(result.error.details.adapter).toBe("mock");
    }
  });

  it("does not call adapter when spec invalid", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render(container, invalidSpec);
    expect(result.ok).toBe(false);
    expect(adapter.mounts).toHaveLength(0);
  });

  it("resolves container from selector", () => {
    const adapter = new MockAdapter("mock");
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const result = api.render("#chart", validSpec);
    expect(result.ok).toBe(true);
    expect(adapter.mounts[0]?.container).toBe(container);
  });
});

describe("registerAdapter and use", () => {
  it("registers and returns adapter", () => {
    const api = chartFn({ defaultAdapter: "mock" });
    const adapter = new MockAdapter("custom");

    api.registerAdapter("custom", adapter);
    expect(api.use("custom")).toBe(adapter);
    expect(api.use("missing")).toBeUndefined();
  });
});
