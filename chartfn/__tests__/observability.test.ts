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

  it.each([
    { data: { series: [{ name: "PRIVATE_CUSTOMER", values: [12345] }] } },
    "PRIVATE_CUSTOMER secret chart data",
  ])("does not log an unvalidated type value", type => {
    const api = chartFn({ defaultAdapter: "mock" });
    const result = api.render({} as HTMLElement, { ...spec, type } as unknown as ChartSpec);
    expect(result).toMatchObject({ok:false,error:{code:"SPEC_INVALID",details:{path:"type"}}});
    expect(warnSpy).toHaveBeenCalledWith("chartfn.render.invalidSpec", {code:"SPEC_INVALID",path:"type"});
    expect(JSON.stringify([debugSpy.mock.calls,infoSpy.mock.calls,warnSpy.mock.calls,errorSpy.mock.calls])).not.toContain("PRIVATE_CUSTOMER");
  });

  it("does not expose an adapter error containing chart data in the public envelope", () => {
    const secret = JSON.stringify({data:{series:[{name:"PRIVATE_CUSTOMER",values:[12345]}]}});
    const api = chartFn({defaultAdapter:"private",adapters:{private:{name:"private",mount(){throw new Error(secret)}}}});
    const result = api.render({} as HTMLElement,spec);
    expect(result).toEqual({ok:false,error:{code:"ADAPTER_ERROR",message:"Adapter failed during mount",details:{adapter:"private"}}});
    expect(JSON.stringify([result,debugSpy.mock.calls,infoSpy.mock.calls,warnSpy.mock.calls,errorSpy.mock.calls])).not.toContain("PRIVATE_CUSTOMER");
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
      .map((call) => JSON.stringify(call))
      .join("\n");

    expect(messages.includes(seriesString)).toBe(false);
  });
});
