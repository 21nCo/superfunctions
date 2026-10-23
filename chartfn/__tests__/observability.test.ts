import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chartFn } from "../src/chart-fn.js";
import { ChartSpec } from "../src/types.js";

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

const seriesString = JSON.stringify(spec.data.series);

describe("observability", () => {
  const originalEnv = { ...process.env };
  const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.CHARTFN_LOG_LEVEL;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    debugSpy.mockClear();
    infoSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  it("does not log full series in production", () => {
    const adapter = {
      name: "mock",
      mount: () => ({ update: vi.fn(), dispose: vi.fn() }),
    };
    const api = chartFn({ defaultAdapter: "mock", adapters: { mock: adapter } });

    // Trigger validation error log
    api.render({} as HTMLElement, { ...spec, data: { series: [] } });

    const messages = [
      debugSpy.mock.calls,
      infoSpy.mock.calls,
      warnSpy.mock.calls,
      errorSpy.mock.calls,
    ]
      .flat()
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");

    expect(messages.includes(seriesString)).toBe(false);
  });
});
