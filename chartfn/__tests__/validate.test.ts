import { describe, expect, it } from "vitest";

import {
  MAX_POINTS_PER_SERIES,
  MAX_SERIES,
  MAX_SPEC_BYTES,
  validateChartSpec,
} from "../src/index.js";

const baseSpec = () => ({
  type: "bar",
  data: {
    series: [{ name: "A", values: [1, 2, 3] }],
  },
});

describe("validateChartSpec", () => {
  it("accepts a valid spec", () => {
    const result = validateChartSpec(baseSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toBeNull();
    }
  });

  it("rejects missing type", () => {
    const spec = baseSpec();
    delete (spec as { type?: string }).type;

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("type");
    }
  });

  it("rejects empty series", () => {
    const spec = { ...baseSpec(), data: { series: [] } };

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("data.series");
    }
  });

  it("rejects unknown chart type", () => {
    const spec = { ...baseSpec(), type: "unknown" };

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("type");
    }
  });

  it("enforces max series length", () => {
    const series = Array.from({ length: MAX_SERIES + 1 }, (_, index) => ({
      name: `S${index}`,
      values: [1],
    }));
    const spec = { ...baseSpec(), data: { series } };

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("data.series");
    }
  });

  it("enforces max points per series", () => {
    const values = Array.from(
      { length: MAX_POINTS_PER_SERIES + 1 },
      (_, index) => index,
    );
    const spec = {
      ...baseSpec(),
      data: { series: [{ name: "A", values }] },
    };

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("data.series[0].values");
    }
  });

  it("enforces max JSON size", () => {
    const bigString = "x".repeat(MAX_SPEC_BYTES + 16);
    const spec = {
      ...baseSpec(),
      data: {
        series: [{ name: "A", values: [1, 2, 3] }],
        labels: [bigString],
      },
    };

    const result = validateChartSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SPEC_INVALID");
      expect(result.error.details.path).toBe("spec");
    }
  });
});
