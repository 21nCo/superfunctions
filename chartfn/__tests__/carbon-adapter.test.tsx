import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [] as Array<{ name: string; config: any; destroy: ReturnType<typeof vi.fn> }>, fail: false }));
vi.mock("@carbon/charts", () => Object.fromEntries(["SimpleBarChart", "GroupedBarChart", "LineChart", "ScatterChart", "PieChart", "DonutChart", "AreaChart", "ComboChart"].map(name => [name, class {
  destroy = vi.fn();
  constructor(_holder: unknown, config: unknown) {
    if (state.fail) throw new Error("vendor failure");
    state.calls.push({ name, config, destroy: this.destroy });
  }
}])));
import { carbonAdapter, _private } from "../src/adapters/carbon.js";
import type { ChartSpec } from "../src/types.js";
const spec: ChartSpec = { type: "bar", data: { series: [{ name: "A", values: [1, 2, 3] }], dimensions: ["Q1", "Q2", "Q3"] } };
const container = () => {
  const children: any[] = [];
  return { children, clientHeight: 300, ownerDocument: { createElement: () => { const element = { remove: vi.fn(() => { const i = children.indexOf(element); if (i >= 0) children.splice(i, 1); }) }; return element; } }, appendChild: (child: unknown) => children.push(child) } as unknown as HTMLElement;
};
describe("Carbon adapter", () => {
  beforeEach(() => { state.calls = []; state.fail = false; });
  it("uses actual mixed series and distinct dataset names", () => {
    const host = container();
    carbonAdapter.mount(host, { ...spec, type: "combo", data: { series: [{ name: "A", values: [1] }, { name: "A", values: [2] }, { type: "area", values: [3] }] } });
    expect(state.calls[0].name).toBe("ComboChart");
    expect(state.calls[0].config.options.comboChartTypes).toEqual([
      { type: "simple-bar", correspondingDatasets: ["A"] },
      { type: "line", correspondingDatasets: ["A (2)"] },
      { type: "area", correspondingDatasets: ["Series 3"] },
    ]);
  });
  it("uses numeric indices for linear and scatter axes", () => {
    for (const value of [{ ...spec, options: { axes: { x: { type: "linear" as const } } } }, { ...spec, type: "scatter" as const }]) {
      const config = _private.buildCarbonConfig(value);
      expect(config.data.map(row => row.key)).toEqual([0, 1, 2]);
      expect(config.options.axes).toMatchObject({ bottom: { scaleType: "linear" } });
    }
  });
  it("maps pie labels to separate slices instead of collapsing a series", () => {
    expect(_private.buildCarbonConfig({ ...spec, type: "pie" }).data).toEqual([
      { group: "Q1", value: 1 }, { group: "Q2", value: 2 }, { group: "Q3", value: 3 },
    ]);
    const config = _private.buildCarbonConfig({ type: "donut", data: { labels: ["same"], series: [{ name: "A", values: [1] }, { name: "B", values: [2] }] } });
    expect(config.data.map(row => row.group)).toEqual(["A: same", "B: same"]);
  });
  it("uses labels when dimensions is an empty optional array", () => {
    const data = { ...spec.data, dimensions: [], labels: ["First", "Second", "Third"] };
    expect(_private.buildCarbonConfig({ ...spec, data }).data.map(row => row.key)).toEqual(data.labels);
    expect(_private.buildCarbonConfig({ ...spec, type: "pie", data }).data.map(row => row.group)).toEqual(data.labels);
  });
  it("maps themes and honors explicit Carbon passthrough", () => {
    expect(_private.buildCarbonConfig({ ...spec, options: { theme: "dark" } }).options.theme).toBe("g100");
    expect(_private.buildCarbonConfig({ ...spec, options: { theme: "light" }, passthrough: { carbonOptions: { theme: "g90", height: "250px" } } }).options).toMatchObject({ theme: "g90", height: "250px" });
  });
  it("uses grouped bars for multiple datasets", () => {
    carbonAdapter.mount(container(), { ...spec, data: { series: [{ values: [1] }, { values: [2] }] } });
    expect(state.calls[0].name).toBe("GroupedBarChart");
  });
  it("replaces charts on update and disposes idempotently", async () => {
    const host = container(); const handle = carbonAdapter.mount(host, spec);
    handle.update({ ...spec, type: "line" });
    expect(state.calls.map(call => call.name)).toEqual(["SimpleBarChart", "LineChart"]);
    expect(state.calls[0].destroy).toHaveBeenCalledOnce();
    expect(host.children.length).toBe(1);
    handle.dispose(); handle.dispose(); handle.update(spec);
    expect(state.calls[1].destroy).toHaveBeenCalledOnce();
    expect(host.children.length).toBe(0);
    await expect(handle.toImage?.()).rejects.toThrow("disposed");
  });
  it("keeps the prior chart after invalid updates or construction failure", () => {
    const host = container(); const handle = carbonAdapter.mount(host, spec);
    expect(() => handle.update({ ...spec, type: "invalid" } as any)).toThrow();
    state.fail = true;
    expect(() => handle.update({ ...spec, type: "line" })).toThrow("vendor failure");
    expect(host.children.length).toBe(1);
    expect(state.calls[0].destroy).not.toHaveBeenCalled();
    handle.dispose();
    expect(host.children.length).toBe(0);
  });
  it("rejects invalid export dimensions before touching rendering APIs", async () => {
    const handle = carbonAdapter.mount(container(), spec);
    await expect(handle.toImage?.({ width: 0 })).rejects.toThrow("positive");
    await expect(handle.toImage?.({ height: Infinity })).rejects.toThrow("positive");
  });
});
