import React from "react";
import { createRoot, Root } from "react-dom/client";
import {
  SimpleBarChart,
  LineChart,
  ScatterChart,
  PieChart,
  DonutChart,
  AreaChart,
} from "@carbon/charts-react";

import { ChartAdapter, ChartAdapterHandle, ChartSpec } from "../types.js";

type CarbonComponent = any;

type CarbonConfig = {
  component: CarbonComponent;
  data: Array<Record<string, unknown>>;
  options: Record<string, unknown>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getSeriesValues = (series: unknown): number[] => {
  if (!isObject(series)) {
    return [];
  }
  const values = (series as { values?: unknown }).values;
  return Array.isArray(values) ? values.map((value) => Number(value)) : [];
};

const getSeriesName = (series: unknown, fallback: string): string => {
  if (isObject(series)) {
    const name = (series as { name?: unknown }).name;
    if (typeof name === "string" && name.trim().length > 0) {
      return name;
    }
  }
  return fallback;
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
  return values.map((_, index) => `Category ${index + 1}`);
};

const buildCartesianData = (spec: ChartSpec): Array<Record<string, unknown>> => {
  const categories = buildCategories(spec);
  const data: Array<Record<string, unknown>> = [];

  spec.data.series.forEach((series, seriesIndex) => {
    const key = getSeriesName(series, `Series ${seriesIndex + 1}`);
    const values = getSeriesValues(series);
    values.forEach((value, index) => {
      data.push({ group: key, key: categories[index] ?? `Category ${index + 1}`, value });
    });
  });

  return data;
};

const buildPieData = (spec: ChartSpec): Array<Record<string, unknown>> => {
  const categories = buildCategories(spec);
  const data: Array<Record<string, unknown>> = [];

  spec.data.series.forEach((series, seriesIndex) => {
    const group = getSeriesName(series, `Series ${seriesIndex + 1}`);
    const values = getSeriesValues(series);
    values.forEach((value, index) => {
      data.push({ group, key: categories[index] ?? `Slice ${index + 1}`, value });
    });
  });

  return data;
};

const buildOptions = (spec: ChartSpec, axesEnabled: boolean) => {
  const legend = spec.options?.legend;
  const axes = spec.options?.axes;

  const options: Record<string, unknown> = {
    title: spec.options?.title,
    legend: legend?.show === false ? { enabled: false } : undefined,
    theme: typeof spec.options?.theme === "string" ? spec.options.theme : undefined,
  };

  if (legend?.position) {
    options.legend = {
      ...(isObject(options.legend) ? options.legend : {}),
      position: legend.position,
    };
  }

  if (axesEnabled) {
    options.axes = {
      left: {
        title: axes?.y?.label,
        mapsTo: "value",
        scaleType: axes?.y?.type === "linear" ? "linear" : "linear",
      },
      bottom: {
        title: axes?.x?.label,
        mapsTo: "key",
        scaleType: axes?.x?.type === "linear" ? "linear" : "labels",
      },
    };
  }

  if (isObject(spec.passthrough?.carbonOptions)) {
    return { ...options, ...spec.passthrough?.carbonOptions };
  }

  return options;
};

const buildCarbonConfig = (spec: ChartSpec): CarbonConfig => {
  switch (spec.type) {
    case "bar":
      return {
        component: SimpleBarChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
    case "line":
      return {
        component: LineChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
    case "area":
      return {
        component: AreaChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
    case "scatter":
      return {
        component: ScatterChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
    case "pie":
      return {
        component: PieChart,
        data: buildPieData(spec),
        options: buildOptions(spec, false),
      };
    case "donut":
      return {
        component: DonutChart,
        data: buildPieData(spec),
        options: buildOptions(spec, false),
      };
    case "combo":
      return {
        component: SimpleBarChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
    default:
      return {
        component: SimpleBarChart,
        data: buildCartesianData(spec),
        options: buildOptions(spec, true),
      };
  }
};

const renderChart = (root: Root, spec: ChartSpec) => {
  const config = buildCarbonConfig(spec);
  const Component = config.component;
  root.render(React.createElement(Component, { data: config.data, options: config.options }));
};

export const carbonAdapter: ChartAdapter = {
  name: "carbon",
  mount(container, spec): ChartAdapterHandle {
    const root = createRoot(container);
    renderChart(root, spec);
    let disposed = false;

    return {
      update(nextSpec) {
        if (disposed) {
          return;
        }
        renderChart(root, nextSpec);
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        root.unmount();
      },
    };
  },
};

export const _private = { buildCarbonConfig };
