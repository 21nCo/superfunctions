import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("chart.js", () => {
  const ChartMock = vi.fn().mockImplementation(() => ({
    update: vi.fn(),
    destroy: vi.fn(),
    config: {},
  }));
  ChartMock.register = vi.fn();
  ChartMock._instances = [];
  ChartMock.mockImplementation(() => {
    const instance = {
      update: vi.fn(),
      destroy: vi.fn(),
      config: {},
    };
    ChartMock._instances.push(instance);
    return instance;
  });

  return {
    Chart: ChartMock,
    register: ChartMock.register,
    BarController: {},
    BarElement: {},
    LineController: {},
    LineElement: {},
    PointElement: {},
    PieController: {},
    DoughnutController: {},
    ArcElement: {},
    CategoryScale: {},
    LinearScale: {},
    Legend: {},
    Title: {},
    Tooltip: {},
    ScatterController: {},
  };
});

import { chartjsAdapter } from "../src/adapters/chartjs.js";
import { ChartSpec } from "../src/types.js";
import { Chart } from "chart.js";

const canvas = {
  getContext: vi.fn(() => ({})),
} as unknown as HTMLCanvasElement;

const spec: ChartSpec = {
  type: "bar",
  data: {
    series: [{ name: "A", values: [1, 2, 3] }],
    dimensions: ["Q1", "Q2", "Q3"],
  },
  options: {
    title: "Test",
    legend: { show: true, position: "top" },
  },
};

describe("chartjsAdapter", () => {
  beforeEach(() => {
    const ChartMock = Chart as unknown as { _instances: Array<unknown> };
    ChartMock._instances = [];
  });

  it("mounts and renders", () => {
    const handle = chartjsAdapter.mount(canvas, spec);

    expect(Chart).toHaveBeenCalledTimes(1);
    expect(handle.update).toBeTypeOf("function");
    expect(handle.dispose).toBeTypeOf("function");
  });

  it("updates and disposes", () => {
    const handle = chartjsAdapter.mount(canvas, spec);
    const chartInstance = (Chart as unknown as { _instances: Array<{ update: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> })._instances[0];

    handle.update({
      ...spec,
      data: { series: [{ name: "B", values: [3, 2, 1] }] },
    });

    expect(chartInstance.update).toHaveBeenCalledTimes(1);

    handle.dispose();
    handle.dispose();

    expect(chartInstance.destroy).toHaveBeenCalledTimes(1);
  });
});
