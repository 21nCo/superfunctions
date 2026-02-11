import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Chart } from "../src/Chart.js";
import { chartFn, ChartSpec } from "chartfn";

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

describe("Chart React binding", () => {
  it("disposes on unmount", async () => {
    const dispose = vi.fn();
    const adapter = {
      name: "mock",
      mount: () => ({
        update: vi.fn(),
        dispose,
      }),
    };

    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });
    const { unmount } = render(<Chart spec={spec} api={api} />);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
