import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  PieController,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Legend,
  Title,
  Tooltip,
  ScatterController,
  Filler,
} from "chart.js";

import { assertChartSpec } from "../validate.js";
import { ChartAdapter, ChartAdapterHandle, ChartSpec } from "../types.js";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  PieController,
  DoughnutController,
  ArcElement,
  CategoryScale,
  LinearScale,
  Legend,
  Title,
  Tooltip,
  ScatterController,
  Filler,
);

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

const buildLabels = (spec: ChartSpec): string[] => {
  if (Array.isArray(spec.data.dimensions) && spec.data.dimensions.length > 0) {
    return spec.data.dimensions;
  }
  if (Array.isArray(spec.data.labels) && spec.data.labels.length > 0) {
    return spec.data.labels;
  }
  const values = getSeriesValues(spec.data.series[0]);
  return values.map((_, index) => `Label ${index + 1}`);
};

const chartTypeMap: Record<ChartSpec["type"], string> = {
  bar: "bar",
  line: "line",
  area: "line",
  pie: "pie",
  scatter: "scatter",
  donut: "doughnut",
  combo: "bar",
};

const buildConfig = (spec: ChartSpec) => {
  const labels = buildLabels(spec);
  const datasets = spec.data.series.map((series, index) => {
    const values = getSeriesValues(series);
    const label = getSeriesName(series, `Series ${index + 1}`);
    const dataset: Record<string, unknown> = {
      label,
      data: spec.type === "scatter" || spec.options?.axes?.x?.type === "linear" ? values.map((y, x) => ({ x, y })) : values,
    };

    const seriesType = spec.type === 'combo' ? (series.type ?? (index === 0 ? 'bar' : 'line')) : spec.type;
    if (spec.type === 'combo') dataset.type = seriesType === 'area' ? 'line' : seriesType;
    if (seriesType === "area") {
      dataset.fill = true;
    }

    return dataset;
  });

  const type = chartTypeMap[spec.type] ?? "bar";

  const config: Record<string, unknown> = {
    type,
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      plugins: {
        title: spec.options?.title ? { display: true, text: spec.options.title } : undefined,
        legend:
          spec.options?.legend?.show === false
            ? { display: false }
            : spec.options?.legend?.position
              ? { position: spec.options.legend.position }
              : undefined,
      },
      scales: spec.type === "pie" || spec.type === "donut" ? {} : {
        x:
          spec.options?.axes?.x?.type === "linear" || spec.type === "scatter"
            ? { type: "linear", title: { display: !!spec.options?.axes?.x?.label, text: spec.options?.axes?.x?.label } }
            : { type: "category", title: { display: !!spec.options?.axes?.x?.label, text: spec.options?.axes?.x?.label } },
        y: {
          type: "linear",
          title: { display: !!spec.options?.axes?.y?.label, text: spec.options?.axes?.y?.label },
        },
      },
    },
  };

  const passthrough = spec.passthrough?.chartjsOptions;
  if (isObject(passthrough)) {
    config.options = { ...(config.options as Record<string, unknown>), ...passthrough };
  }

  return config;
};

export const chartjsAdapter: ChartAdapter = {
  name: "chartjs",
  mount(container, spec): ChartAdapterHandle {
    assertChartSpec(spec);
    const ownsCanvas = container.tagName?.toLowerCase() !== 'canvas' && !('getContext' in container);
    const canvas = ownsCanvas ? container.ownerDocument.createElement('canvas') : container as HTMLCanvasElement;
    if (ownsCanvas) container.appendChild(canvas);
    const context = canvas.getContext?.("2d");
    if (!context) {
      if (ownsCanvas) canvas.remove();
      throw new Error("Chart.js adapter requires a canvas element with 2d context");
    }

    if (Chart.getChart?.(canvas)) throw new Error('Canvas already has a chart; dispose its handle before rendering again');
    let chart: Chart;
    try { chart = new Chart(context, buildConfig(spec) as any); }
    catch (error) {
      try { Chart.getChart?.(canvas)?.destroy(); } catch {}
      if (ownsCanvas) canvas.remove();
      throw error;
    }
    let disposed = false;

    return {
      update(nextSpec) {
        if (disposed) {
          return;
        }
        assertChartSpec(nextSpec);
        const next = buildConfig(nextSpec) as any;
        (chart.config as any).type = next.type;
        chart.data = next.data;
        chart.options = next.options;
        chart.update();
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        try { chart.destroy(); } finally { if (ownsCanvas) canvas.remove(); }
      },
    };
  },
};

export const _private = { buildConfig };
