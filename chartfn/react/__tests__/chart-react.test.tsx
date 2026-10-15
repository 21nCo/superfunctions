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

it("updates in place and remounts when the adapter or API changes", () => {
  const update = vi.fn(); const dispose = vi.fn();
  const mount = vi.fn(() => ({ update, dispose }));
  const api = chartFn({ defaultAdapter: "one", adapters: { one: { name: "one", mount }, two: { name: "two", mount } } });
  const next = { ...spec, data: { series: [{ values: [5, 6] }] } };
  const view = render(<Chart spec={spec} api={api} />);
  view.rerender(<Chart spec={next} api={api} />);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(next);
  expect(dispose).not.toHaveBeenCalled();
  view.rerender(<Chart spec={next} api={api} adapter="two" />);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(mount).toHaveBeenCalledTimes(2);
  const otherApi = chartFn({ defaultAdapter: "two", adapters: { two: { name: "two", mount } } });
  view.rerender(<Chart spec={next} api={otherApi} adapter="two" />);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(mount).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(dispose).toHaveBeenCalledTimes(3);
});

it("balances every mount with disposal in StrictMode", () => {
  const dispose = vi.fn(); const mount = vi.fn(() => ({ update: vi.fn(), dispose }));
  const api = chartFn({ defaultAdapter: "mock", adapters: { mock: { name: "mock", mount } } });
  const view = render(<React.StrictMode><Chart spec={spec} api={api} /></React.StrictMode>);
  view.unmount();
  expect(mount.mock.calls.length).toBeGreaterThan(0);
  expect(dispose).toHaveBeenCalledTimes(mount.mock.calls.length);
});
