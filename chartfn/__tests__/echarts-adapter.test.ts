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

import * as echarts from "echarts";
import { echartsAdapter } from "../src/adapters/echarts.js";
import { ChartSpec } from "../src/types.js";

const container = { id: "chart" } as unknown as HTMLElement;

const spec: ChartSpec = {
  type: "bar",
  data: {
    series: [{ name: "A", values: [1, 2, 3] }],
    dimensions: ["Q1", "Q2", "Q3"],
  },
  options: {
    legend: { show: true, position: "top" },
  },
};

describe("echartsAdapter", () => {
  it("mounts and renders", () => {
    const handle = echartsAdapter.mount(container, spec);
    const init = (echarts as unknown as { init: ReturnType<typeof vi.fn> }).init;
    const instances = (echarts as unknown as { __instances: Array<{ setOption: ReturnType<typeof vi.fn> }> }).__instances;

    expect(init).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(instances[0].setOption).toHaveBeenCalledTimes(1);
    expect(handle.update).toBeTypeOf("function");
    expect(handle.dispose).toBeTypeOf("function");
  });

  it("updates and disposes", () => {
    const handle = echartsAdapter.mount(container, spec);
    const instances = (echarts as unknown as { __instances: Array<{ setOption: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }).__instances;
    const instance = instances[instances.length - 1];

    handle.update({
      ...spec,
      data: { series: [{ name: "B", values: [3, 2, 1] }] },
    });

    expect(instance.setOption).toHaveBeenCalledTimes(2);

    handle.dispose();
    handle.dispose();

    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });
});
