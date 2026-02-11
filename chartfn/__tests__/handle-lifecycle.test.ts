import { describe, expect, it, vi } from "vitest";

import { chartFn } from "../src/chart-fn.js";
import { ChartSpec } from "../src/types.js";

const createHandle = () => ({
  update: vi.fn(),
  dispose: vi.fn(),
});

describe("handle lifecycle", () => {
  it("updates without remounting", () => {
    const handle = createHandle();
    const mount = vi.fn(() => handle);
    const adapter = { name: "mock", mount };
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const spec: ChartSpec = {
      type: "bar",
      data: { series: [{ name: "A", values: [1, 2, 3] }] },
    };

    const result = api.render({} as HTMLElement, spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.result.update({
        ...spec,
        data: { series: [{ name: "B", values: [3, 2, 1] }] },
      });
      expect(handle.update).toHaveBeenCalledTimes(1);
      expect(mount).toHaveBeenCalledTimes(1);
    }
  });

  it("dispose is idempotent", () => {
    const handle = createHandle();
    const adapter = { name: "mock", mount: vi.fn(() => handle) };
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    const spec: ChartSpec = {
      type: "bar",
      data: { series: [{ name: "A", values: [1, 2, 3] }] },
    };

    const result = api.render({} as HTMLElement, spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.result.dispose();
      result.result.dispose();
      expect(handle.dispose).toHaveBeenCalledTimes(2);
    }
  });
});
