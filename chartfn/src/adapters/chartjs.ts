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
} from "chart.js";

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
      data: values,
    };

    if (spec.type === "area") {
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
      scales: {
        x:
          spec.options?.axes?.x?.type === "linear"
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
    const context = (container as HTMLCanvasElement).getContext?.("2d");
    if (!context) {
      throw new Error("Chart.js adapter requires a canvas element with 2d context");
    }

    const chart = new Chart(context, buildConfig(spec) as any);
    let disposed = false;

    return {
      update(nextSpec) {
        if (disposed) {
          return;
        }
        chart.data = (buildConfig(nextSpec) as any).data;
        chart.options = (buildConfig(nextSpec) as any).options;
        chart.update();
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        chart.destroy();
      },
    };
  },
};

export const _private = { buildConfig };
