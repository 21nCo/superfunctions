import { describe, expect, it, vi } from "vitest";

vi.mock("echarts", () => {
  const init = vi.fn(() => ({
    setOption: vi.fn(),
    dispose: vi.fn(),
    getDataURL: vi.fn(() => "data:image/png;base64,abc123"),
  }));

  return { init };
});

import { echartsAdapter } from "../src/adapters/echarts.js";
import { ChartSpec } from "../src/types.js";

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

describe("toImage", () => {
  it("returns a string data URL", async () => {
    const handle = echartsAdapter.mount({} as HTMLElement, spec);
    const result = await handle.toImage?.({ format: "png" });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^data:image\/png/);
  });
});
