import {
  SimpleBarChart, GroupedBarChart, LineChart, ScatterChart, PieChart,
  DonutChart, AreaChart, ComboChart,
} from "@carbon/charts";
import type { ChartAdapter, ChartAdapterHandle, ChartSpec } from "../types.js";
import { assertChartSpec } from "../validate.js";

type CarbonChart = { destroy(): void };
type CarbonConstructor = new (container: HTMLDivElement, config: any) => CarbonChart;
type CarbonConfig = { component: CarbonConstructor; data: Array<Record<string, unknown>>; options: Record<string, unknown> };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const values = (series: ChartSpec["data"]["series"][number]): number[] => series.values as number[];
const names = (spec: ChartSpec): string[] => {
  const used = new Set<string>();
  return spec.data.series.map((series, index) => {
    const base = typeof series.name === "string" && series.name.trim() ? series.name : `Series ${index + 1}`;
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base} (${suffix})`;
    used.add(name);
    return name;
  });
};
const categories = (spec: ChartSpec): string[] =>
  spec.data.dimensions?.length ? spec.data.dimensions : spec.data.labels ?? [];

const buildCarbonConfig = (spec: ChartSpec): CarbonConfig => {
  assertChartSpec(spec);
  const seriesNames = names(spec);
  const labels = categories(spec);
  const circular = spec.type === "pie" || spec.type === "donut";
  const numeric = spec.type === "scatter" || spec.options?.axes?.x?.type === "linear";
  const data = spec.data.series.flatMap((series, seriesIndex) => values(series).map((value, index) => {
    const category = labels[index] ?? `Category ${index + 1}`;
    return circular
      ? { group: spec.data.series.length === 1 ? category : `${seriesNames[seriesIndex]}: ${category}`, value }
      : { group: seriesNames[seriesIndex], key: numeric ? index : category, value };
  }));
  const options: Record<string, unknown> = {
    title: spec.options?.title ?? "",
    animations: false,
    theme: spec.options?.theme === "dark" ? "g100" : "white",
    legend: { enabled: spec.options?.legend?.show !== false, ...(spec.options?.legend?.position ? { position: spec.options.legend.position } : {}) },
  };
  if (!circular) options.axes = {
    left: { title: spec.options?.axes?.y?.label, mapsTo: "value", scaleType: "linear" },
    bottom: { title: spec.options?.axes?.x?.label, mapsTo: "key", scaleType: numeric ? "linear" : "labels" },
  };
  let component: CarbonConstructor;
  switch (spec.type) {
    case "bar": component = spec.data.series.length > 1 ? GroupedBarChart : SimpleBarChart; break;
    case "line": component = LineChart; break;
    case "area": component = AreaChart; break;
    case "scatter": component = ScatterChart; break;
    case "pie": component = PieChart; break;
    case "donut": component = DonutChart; break;
    case "combo":
      component = ComboChart;
      options.comboChartTypes = spec.data.series.map((series, index) => ({
        type: (series.type ?? (index === 0 ? "bar" : "line")) === "bar" ? "simple-bar" : series.type ?? "line",
        correspondingDatasets: [seriesNames[index]],
      }));
      break;
  }
  return { component, data, options: { ...options, ...(isObject(spec.passthrough?.carbonOptions) ? spec.passthrough.carbonOptions : {}) } };
};

const exportImage = async (holder: HTMLDivElement, options?: { format?: "png" | "svg"; width?: number; height?: number }): Promise<string> => {
  for (const size of [options?.width, options?.height]) {
    if (size !== undefined && (!Number.isFinite(size) || size <= 0)) throw new RangeError("Image dimensions must be positive finite numbers");
  }
  const format = options?.format ?? "png";
  if (format !== "svg" && format !== "png") throw new TypeError("Unsupported image format");
  // Carbon performs its first layout through the browser rendering queue.
  const view = holder.ownerDocument.defaultView;
  if (!view) throw new Error("Chart document has no window");
  await new Promise<void>(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())));
  const svg = holder.querySelector("svg.layout-svg-wrapper");
  if (!svg) throw new Error("Carbon chart has no rendered SVG");
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const properties = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "visibility", "display", "clip-path", "filter"];
  originals.forEach((element, index) => {
    const style = view.getComputedStyle(element);
    const target = copies[index] as SVGElement;
    for (const property of properties) target.style.setProperty(property, style.getPropertyValue(property).replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, "url(#$1)"));
  });
  const bounds = svg.getBoundingClientRect();
  const width = options?.width ?? bounds.width;
  const height = options?.height ?? bounds.height;
  if (width <= 0 || height <= 0) throw new Error("Carbon chart has no measurable dimensions");
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  if (format === "svg") return uri;
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot rasterize Carbon chart SVG")); image.src = uri; });
  const canvas = holder.ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D export is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

export const carbonAdapter: ChartAdapter = {
  name: "carbon",
  mount(container, spec): ChartAdapterHandle {
    let current: { chart: CarbonChart; holder: HTMLDivElement };
    let disposed = false;
    const create = (next: ChartSpec) => {
      const config = buildCarbonConfig(next);
      const holder = container.ownerDocument.createElement("div");
      container.appendChild(holder);
      try {
        const chart = new config.component(holder, { data: config.data, options: { height: `${container.clientHeight || 400}px`, width: "100%", ...config.options } });
        return { chart, holder };
      } catch (error) {
        holder.remove();
        throw error;
      }
    };
    current = create(spec);
    return {
      update(next) {
        if (disposed) return;
        const replacement = create(next);
        const previous = current;
        current = replacement;
        try { previous.chart.destroy(); } finally { previous.holder.remove(); }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try { current.chart.destroy(); } finally { current.holder.remove(); }
      },
      async toImage(options) {
        if (disposed) throw new Error("Cannot export a disposed chart");
        const target = current;
        const image = await exportImage(target.holder, options);
        if (disposed || target !== current) throw new Error("Chart changed during image export");
        return image;
      },
    };
  },
};
export const _private = { buildCarbonConfig };
