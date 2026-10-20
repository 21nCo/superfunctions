import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("chart.js", () => {
  const ChartMock = vi.fn().mockImplementation(() => ({
    update: vi.fn(),
    destroy: vi.fn(),
    config: {},
  }));
  ChartMock.register = vi.fn();
  ChartMock._instances = [];
  ChartMock.mockImplementation(function () {
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
    Filler: {},
  };
});

import { chartjsAdapter, _private } from "../src/adapters/chartjs.js";
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


describe('Chart.js chart contracts', () => {
  it.each(['pie', 'donut'] as const)('keeps %s values numeric when reusing linear-axis options', type => {
    const config = _private.buildConfig({ ...spec, type, options: { axes: { x: { type: 'linear' } } } }) as any;
    expect(config.data.datasets[0].data).toEqual([1, 2, 3]);
    expect(config.options.scales).toEqual({});
  });
  it('builds scatter coordinates and radial charts without Cartesian scales', () => {
    const scatter = _private.buildConfig({ ...spec, type: 'scatter' }) as any;
    expect(scatter.data.datasets[0].data).toEqual([{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }]);
    expect(scatter.options.scales.x.type).toBe('linear');
    expect((_private.buildConfig({ ...spec, type: 'pie' }) as any).options.scales).toEqual({});
  });
  it('builds mixed series and updates the vendor chart type', () => {
    const combo = _private.buildConfig({ ...spec, type: 'combo', data: { series: [{ values: [1], type: 'area' }, { values: [2] }] } }) as any;
    expect(combo.data.datasets.map((item: any) => item.type)).toEqual(['line', 'line']);
    expect(combo.data.datasets[0].fill).toBe(true);
    const handle = chartjsAdapter.mount(canvas, spec);
    handle.update({ ...spec, type: 'line' });
    const instances = (Chart as any)._instances;
    expect(instances[instances.length - 1].config.type).toBe('line');
  });
});
