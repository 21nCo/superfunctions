import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import Chart from "../src/Chart.svelte";
import { chartFn, ChartSpec } from "chartfn";

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

describe("Chart Svelte binding", () => {
  it("disposes on destroy", () => {
    const dispose = vi.fn();
    const adapter = {
      name: "mock",
      mount: () => ({
        update: vi.fn(),
        dispose,
      }),
    };

    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });
    const { unmount } = render(Chart, { spec, api });

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it("updates in place and replaces handles when the adapter or API changes", async () => {
  const update = vi.fn(); const dispose = vi.fn();
  const mount = vi.fn(() => ({ update, dispose }));
  const api = chartFn({ defaultAdapter: "one", adapters: { one: { name: "one", mount }, two: { name: "two", mount } } });
  const next = { ...spec, data: { series: [{ values: [5, 6] }] } };
  const view = render(Chart, { spec, api });
  await view.rerender({ spec: next });
  expect(mount).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(next);
  expect(dispose).not.toHaveBeenCalled();
  await view.rerender({ adapter: "two" });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(mount).toHaveBeenCalledTimes(2);
  const otherApi = chartFn({ defaultAdapter: "two", adapters: { two: { name: "two", mount } } });
  await view.rerender({ api: otherApi });
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(mount).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(3);
});
it('updates when Svelte invalidates a spec after nested mutation', async () => {
  const update = vi.fn();
  const api = chartFn({ defaultAdapter: 'mock', adapters: { mock: { name: 'mock', mount: () => ({ update, dispose: vi.fn() }) } } });
  const mutable: ChartSpec = { type: 'bar', data: { series: [{ values: [1] }] } };
  const view = render(Chart, { spec: mutable, api });
  mutable.data.series[0].values = [9, 7];
  await view.rerender({ spec: mutable });
  expect(update).toHaveBeenCalledWith(mutable);
  view.unmount();
});
