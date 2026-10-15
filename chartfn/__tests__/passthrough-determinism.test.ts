import { describe, expect, it, vi } from "vitest";

vi.mock("echarts", () => {
  const instances: Array<{ setOption: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  const init = vi.fn(() => {
    const instance = {
      setOption: vi.fn(),
      dispose: vi.fn(),
    };
    instances.push(instance);
    return instance;
  });

  return { init, __instances: instances };
});

import { echartsAdapter, _private as echartsPrivate } from "../src/adapters/echarts.js";
import { ChartSpec } from "../src/types.js";
import * as echarts from "echarts";

describe("passthrough and determinism", () => {
  it("merges echarts passthrough options", () => {
    const spec: ChartSpec = {
      type: "bar",
      data: { series: [{ name: "A", values: [1, 2] }] },
      passthrough: { echartsOptions: { animation: false } },
    };

    echartsAdapter.mount({} as HTMLElement, spec);
    const instances = (echarts as unknown as { __instances: Array<{ setOption: ReturnType<typeof vi.fn> }> }).__instances;
    const option = instances[instances.length - 1].setOption.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(option.animation).toBe(false);
  });

  it("buildOption is deterministic for same spec", () => {
    const spec: ChartSpec = {
      type: "line",
      data: { series: [{ name: "A", values: [1, 2, 3] }] },
      options: { title: "Deterministic" },
    };

    const first = echartsPrivate.buildOption(spec);
    const second = echartsPrivate.buildOption(spec);

    expect(first).toEqual(second);
  });
});
