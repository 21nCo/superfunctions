import * as echarts from "echarts";

import { ChartAdapter, ChartAdapterHandle, ChartSpec } from "../types.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getSeriesValues = (series: unknown): number[] => {
  if (!isObject(series)) {
    return [];
  }
  const values = (series as { values?: unknown }).values;
  return Array.isArray(values) ? values.map((value) => Number(value)) : [];
};

const buildCategories = (spec: ChartSpec): string[] => {
  if (Array.isArray(spec.data.dimensions) && spec.data.dimensions.length > 0) {
    return spec.data.dimensions;
  }
  if (Array.isArray(spec.data.labels) && spec.data.labels.length > 0) {
    return spec.data.labels;
  }
  const firstSeries = spec.data.series[0];
  const values = getSeriesValues(firstSeries);
  return values.map((_, index) => String(index));
};

const buildPieSeries = (spec: ChartSpec, donut: boolean) => {
  const labels = buildCategories(spec);
  return spec.data.series.map((series) => {
    const values = getSeriesValues(series);
    const data = values.map((value, index) => ({
      name: labels[index] ?? String(index),
      value,
    }));

    return {
      type: "pie",
      radius: donut ? ["40%", "70%"] : "70%",
      data,
      name: isObject(series) ? (series as { name?: string }).name : undefined,
    };
  });
};

const buildCartesianSeries = (spec: ChartSpec, type: string) => {
  return spec.data.series.map((series) => {
    const values = getSeriesValues(series);
    return {
      type,
      data: values,
      name: isObject(series) ? (series as { name?: string }).name : undefined,
    };
  });
};

const buildScatterSeries = (spec: ChartSpec) => {
  return spec.data.series.map((series) => {
    const values = getSeriesValues(series);
    const data = values.map((value, index) => [index, value]);
    return {
      type: "scatter",
      data,
      name: isObject(series) ? (series as { name?: string }).name : undefined,
    };
  });
};

const buildLegend = (spec: ChartSpec): Record<string, unknown> | undefined => {
  const legend = spec.options?.legend;
  if (!legend) {
    return undefined;
  }

  const config: Record<string, unknown> = {};
  if (legend.show === false) {
    config.show = false;
  }

  if (legend.position) {
    switch (legend.position) {
      case "top":
        config.top = 0;
        config.left = "center";
        break;
      case "bottom":
        config.bottom = 0;
        config.left = "center";
        break;
      case "left":
        config.left = 0;
        config.top = "center";
        config.orient = "vertical";
        break;
      case "right":
        config.right = 0;
        config.top = "center";
        config.orient = "vertical";
        break;
      default:
        break;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
};

const buildAxes = (spec: ChartSpec, cartesian: boolean) => {
  if (!cartesian) {
    return {};
  }

  const axes = spec.options?.axes;
  const xAxisType = axes?.x?.type ?? "category";
  const yAxisType = axes?.y?.type ?? "linear";

  const xAxis: Record<string, unknown> = {
    type: xAxisType === "linear" ? "value" : "category",
    name: axes?.x?.label,
  };

  if (xAxis.type === "category") {
    xAxis.data = buildCategories(spec);
  }

  const yAxis: Record<string, unknown> = {
    type: yAxisType === "linear" ? "value" : yAxisType,
    name: axes?.y?.label,
  };

  return { xAxis, yAxis };
};

const buildOption = (spec: ChartSpec): Record<string, unknown> => {
  const type = spec.type;
  let series: Array<Record<string, unknown>> = [];
  let usesCartesian = true;

  switch (type) {
    case "bar":
      series = buildCartesianSeries(spec, "bar");
      break;
    case "line":
      series = buildCartesianSeries(spec, "line");
      break;
    case "area":
      series = buildCartesianSeries(spec, "line").map((item) => ({
        ...item,
        areaStyle: {},
      }));
      break;
    case "scatter":
      series = buildScatterSeries(spec);
      break;
    case "pie":
      usesCartesian = false;
      series = buildPieSeries(spec, false);
      break;
    case "donut":
      usesCartesian = false;
      series = buildPieSeries(spec, true);
      break;
    case "combo":
      series = buildCartesianSeries(spec, "bar");
      break;
    default:
      series = buildCartesianSeries(spec, "bar");
      break;
  }

  const axes = buildAxes(spec, usesCartesian);
  const legend = buildLegend(spec);

  const option: Record<string, unknown> = {
    title: spec.options?.title ? { text: spec.options.title } : undefined,
    legend,
    series,
    ...axes,
  };

  const passthrough = spec.passthrough?.echartsOptions;
  if (isObject(passthrough)) {
    return { ...option, ...passthrough };
  }

  return option;
};

/**
 * ECharts adapter. Supports optional passthrough via `spec.passthrough.echartsOptions`.
 */
export const echartsAdapter: ChartAdapter = {
  name: "echarts",
  mount(container, spec): ChartAdapterHandle {
    const theme =
      typeof spec.options?.theme === "string" ? spec.options.theme : undefined;
    const instance = echarts.init(container, theme);
    instance.setOption(buildOption(spec), true);

    let disposed = false;

    return {
      update(nextSpec) {
        if (disposed) {
          return;
        }
        instance.setOption(buildOption(nextSpec), true);
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        instance.dispose();
      },
      async toImage(options) {
        if (disposed) {
          return Promise.resolve("");
        }
        const type =
          options?.format === "svg" ? "svg" : "png";
        const dataUrl = instance.getDataURL({
          type,
          pixelRatio: 2,
          backgroundColor: "#fff",
          ...(options?.width ? { width: options.width } : {}),
          ...(options?.height ? { height: options.height } : {}),
        });
        return Promise.resolve(dataUrl);
      },
    };
  },
};

export const _private = { buildOption };
