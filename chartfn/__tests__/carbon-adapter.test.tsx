import { beforeEach, describe, expect, it, vi } from "vitest";

const renderSpy = vi.fn();
const unmountSpy = vi.fn();

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({
    render: renderSpy,
    unmount: unmountSpy,
  })),
}));

vi.mock("@carbon/charts-react", () => {
  const makeComponent = (name: string) => {
    const Component = () => null;
    Component.displayName = name;
    return Component;
  };

  return {
    BarChart: makeComponent("BarChart"),
    LineChart: makeComponent("LineChart"),
    ScatterChart: makeComponent("ScatterChart"),
    PieChart: makeComponent("PieChart"),
    DonutChart: makeComponent("DonutChart"),
    AreaChart: makeComponent("AreaChart"),
  };
});

import { carbonAdapter } from "../src/adapters/carbon.js";
import { ChartSpec } from "../src/types.js";

const container = { id: "chart" } as unknown as HTMLElement;

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

describe("carbonAdapter", () => {
  beforeEach(() => {
    renderSpy.mockClear();
    unmountSpy.mockClear();
  });

  it("mounts and renders", () => {
    const handle = carbonAdapter.mount(container, spec);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(handle.update).toBeTypeOf("function");
    expect(handle.dispose).toBeTypeOf("function");
  });

  it("updates and disposes", () => {
    const handle = carbonAdapter.mount(container, spec);

    handle.update({
      ...spec,
      data: { series: [{ name: "B", values: [3, 2, 1] }] },
    });

    expect(renderSpy).toHaveBeenCalledTimes(2);

    handle.dispose();
    handle.dispose();

    expect(unmountSpy).toHaveBeenCalledTimes(1);
  });
});
