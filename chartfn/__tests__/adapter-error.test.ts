import { describe, expect, it } from "vitest";

import { chartFn } from "../src/chart-fn.js";
import { ChartSpec } from "../src/types.js";

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

describe("ADAPTER_ERROR", () => {
  it("returns ADAPTER_ERROR when adapter throws", () => {
    const adapter = {
      name: "boom",
      mount: () => {
        throw new Error("boom");
      },
    };
    const api = chartFn({ defaultAdapter: "boom", adapters: { boom: adapter } });

    const result = api.render({} as HTMLElement, spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADAPTER_ERROR");
      expect(result.error.details.adapter).toBe("boom");
    }
  });
});
