import * as echarts from "echarts";

import { assertChartSpec } from "../validate.js";
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
  return spec.data.series.map((series, seriesIndex) => {
    const values = getSeriesValues(series);
    const data = values.map((value, index) => ({
      name: labels[index] ?? String(index),
      value,
    }));

    return {
      type: "pie",
      radius: spec.data.series.length > 1
        ? (donut ? [`${25 / spec.data.series.length}%`, `${60 / spec.data.series.length}%`] : `${60 / spec.data.series.length}%`)
        : donut ? ["40%", "70%"] : "70%",
      ...(spec.data.series.length > 1 ? { center: [`${(seriesIndex + 0.5) * 100 / spec.data.series.length}%`, '50%'] } : {}),
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
      data: spec.options?.axes?.x?.type === "linear" ? values.map((value, index) => [index, value]) : values,
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

  return config;
};

const buildAxes = (spec: ChartSpec, cartesian: boolean) => {
  if (!cartesian) {
    return {};
  }

  const axes = spec.options?.axes;
  const xAxisType = axes?.x?.type ?? (spec.type === "scatter" ? "linear" : "category");
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
      series = buildCartesianSeries(spec, "bar").map((item, index) => {
        const type = spec.data.series[index].type ?? (index === 0 ? 'bar' : 'line');
        return { ...item, type: type === 'area' ? 'line' : type, ...(type === 'area' ? { areaStyle: {} } : {}) };
      });
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
    assertChartSpec(spec);
    let currentSpec = spec;
    let theme = spec.options?.theme;
    const create = (nextSpec: ChartSpec) => {
      const mounted = echarts.init(container, nextSpec.options?.theme);
      try { mounted.setOption(buildOption(nextSpec), true); }
      catch (error) { try { mounted.dispose(); } catch {} throw error; }
      return mounted;
    };
    let instance: ReturnType<typeof echarts.init> | undefined = create(spec);

    let disposed = false;

    return {
      update(nextSpec) {
        if (disposed) {
          return;
        }
        assertChartSpec(nextSpec);
        if (!instance || nextSpec.options?.theme !== theme) {
          const previous = instance;
          instance = undefined;
          previous?.dispose();
          instance = create(nextSpec);
          theme = nextSpec.options?.theme;
        } else {
          instance.setOption(buildOption(nextSpec), true);
        }
        currentSpec = nextSpec;
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        instance?.dispose();
      },
      async toImage(options) {
        if (disposed) {
          return Promise.resolve("");
        }
        if (!instance) throw new Error("Chart has no active renderer; call update with a valid specification to recover");
        for (const value of [options?.width, options?.height]) {
          if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError('Image dimensions must be positive finite numbers');
        }
        const type = options?.format ?? 'png';
        if (type === 'png' && options?.width === undefined && options?.height === undefined) {
          return instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
        }
        // ECharts' getDataURL ignores width/height and only supports SVG on its
        // SVG renderer. Render a disposable export instance at the requested size.
        const target = container.ownerDocument.createElement('div');
        const width = options?.width ?? instance.getWidth();
        const height = options?.height ?? instance.getHeight();
        target.style.cssText = `position:fixed;left:-100000px;width:${width}px;height:${height}px`;
        container.ownerDocument.body.appendChild(target);
        let exported: ReturnType<typeof echarts.init> | undefined;
        try {
          exported = echarts.init(target, theme, { renderer: type === 'svg' ? 'svg' : 'canvas', width, height });
          exported.setOption({ ...buildOption(currentSpec), animation: false }, true);
          return exported.getDataURL({ type, pixelRatio: 1, backgroundColor: '#fff' });
        } finally {
          try { exported?.dispose(); } finally { target.remove(); }
        }
      },
    };
  },
};

export const _private = { buildOption };
