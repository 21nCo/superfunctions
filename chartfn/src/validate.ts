import {
  MAX_POINTS_PER_SERIES,
  MAX_SERIES,
  MAX_SPEC_BYTES,
} from "./constants.js";
import {
  ChartSpec,
  ChartSpecSeries,
  ChartType,
  ChartfnEnvelope,
  ChartfnError,
} from "./types.js";

const CHART_TYPES: ChartType[] = [
  "bar",
  "line",
  "area",
  "pie",
  "scatter",
  "donut",
  "combo",
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const fail = (message: string, path?: string): ChartfnEnvelope<null> => ({
  ok: false,
  error: {
    code: "SPEC_INVALID",
    message,
    details: { path },
  } satisfies ChartfnError,
});

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number");

const getValuesArray = (series: unknown): number[] | null => {
  if (!isObject(series)) {
    return null;
  }
  const values = (series as unknown as ChartSpecSeries).values;
  return isNumberArray(values) ? values : null;
};

const getJsonSize = (value: unknown): number => {
  const json = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(json).length;
  }
  return json.length;
};

export const validateChartSpec = (spec: unknown): ChartfnEnvelope<null> => {
  if (!isObject(spec)) {
    return fail("ChartSpec must be an object", "spec");
  }

  const type = (spec as unknown as ChartSpec).type;
  if (!type) {
    return fail("ChartSpec.type is required", "type");
  }
  if (typeof type !== "string" || !CHART_TYPES.includes(type as ChartType)) {
    return fail("ChartSpec.type must be a known ChartType", "type");
  }

  const data = (spec as unknown as ChartSpec).data;
  if (!isObject(data)) {
    return fail("ChartSpec.data is required", "data");
  }
  const series = (data as ChartSpec["data"]).series;
  if (!Array.isArray(series) || series.length === 0) {
    return fail("ChartSpec.data.series must be a non-empty array", "data.series");
  }
  if (series.length > MAX_SERIES) {
    return fail(
      `ChartSpec.data.series exceeds max series (${MAX_SERIES})`,
      "data.series",
    );
  }

  for (let index = 0; index < series.length; index += 1) {
    const values = getValuesArray(series[index]);
    if (!values) {
      return fail(
        "ChartSpec.data.series values must be an array of numbers",
        `data.series[${index}].values`,
      );
    }
    if (values.length > MAX_POINTS_PER_SERIES) {
      return fail(
        `ChartSpec.data.series values exceed max points (${MAX_POINTS_PER_SERIES})`,
        `data.series[${index}].values`,
      );
    }
  }

  try {
    const size = getJsonSize(spec);
    if (size > MAX_SPEC_BYTES) {
      return fail(
        `ChartSpec exceeds max size (${MAX_SPEC_BYTES} bytes)`,
        "spec",
      );
    }
  } catch (error) {
    return fail("ChartSpec must be JSON serializable", "spec");
  }

  return { ok: true, result: null };
};
