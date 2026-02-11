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
