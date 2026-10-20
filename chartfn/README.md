# Chartfn

Charting through a common specification, with ECharts, Chart.js, and Carbon adapters.

**Readiness work is in progress.** The executable acceptance scripts cover vendor rendering, packed consumers, and framework lifecycles; hosted CI remains a separate gate.

## Core usage

```ts
import { chartFn, chartjsAdapter, type ChartSpec } from 'chartfn';
const charts = chartFn({ defaultAdapter: 'chartjs', adapters: { chartjs: chartjsAdapter } });
const spec: ChartSpec = {
  type: 'combo',
  data: { dimensions: ['Q1', 'Q2'], series: [
    { name: 'Revenue', type: 'bar', values: [10, 12] },
    { name: 'Target', type: 'line', values: [11, 11] },
  ] },
};
const result = charts.render('#chart', spec);
if (result.ok) {
  result.result.update(spec);
  result.result.dispose();
}
```

Give the container an explicit width and height. Chart.js accepts a canvas or
creates an owned canvas inside a normal HTML container. Disposal removes owned
canvases; caller-supplied canvases remain in place. Other adapters use HTML containers.

`render` and `validateChartSpec` return success/error envelopes. Invalid selectors
return `ADAPTER_ERROR`; invalid specs return `SPEC_INVALID` before mounting.
Adapter mount failures use a generic public message rather than exposing vendor
exception text, which may contain chart data. Invalid-spec logs contain only the
error code and field path, never the rejected field value.
Handles retain their imperative interface: invalid updates throw, adapter errors
propagate, and exports reject on failure. Disposal is idempotent; updates after
disposal are no-ops and supported exports after disposal return an empty string.

Specs accept finite numeric values, optional string dimensions/labels, at most
100 series, 10,000 points per series, and a 1 MiB serialized payload. Scatter and
linear X axes use the point index as X and the supplied value as Y. Combo charts
accept optional per-series `type: 'bar' | 'line' | 'area'`; by default the first
series is bar and subsequent series are line. Multiple ECharts pie/donut series
are placed side by side so one series cannot obscure another.

Adapter escape hatches are `passthrough.echartsOptions`,
`passthrough.chartjsOptions`, and `passthrough.carbonOptions`; these shallowly
override generated vendor options. Disable vendor animations for repeatable
exports. ECharts exports PNG or SVG, including requested pixel dimensions, using
a temporary export renderer when required. Its theme updates reinitialize the
vendor instance inside the same public handle. The optional `toImage` method is
not required on custom adapters.


## Carbon adapter

Include Carbon's stylesheet when using the adapter:

```ts
import "@carbon/charts/styles.css";
import { carbonAdapter } from "chartfn";
```

Applications with strict dependency isolation should declare `@carbon/charts`
directly to import its stylesheet. The adapter uses Carbon's imperative chart
constructors and does not create a nested React root. `light` and `dark` map to
Carbon's `white` and `g100` themes; `carbonOptions` can override vendor settings.
Updates replace the vendor chart within the same handle, so chart-type and theme
changes take effect. Multi-series bars are grouped. Combo charts render actual
bar/line/area layers. Pie and donut values become individual slices; when several
series are supplied, slice labels include the series name to keep them distinct.

Carbon `toImage` exports the SVG plot and axes as SVG or PNG with requested
positive dimensions. Computed plot styles are embedded so exports retain their
appearance outside the page. Separate HTML elements such as Carbon's title,
legend and toolbar are not included in this plot export. Animations are disabled
by default for deterministic rendering; overriding that setting makes export a
snapshot of the current rendered state. The chart needs a visible, measurable
browser container; image export is not a server-side renderer.

## React binding

```tsx
import { Chart } from "@chartfn/react";
import { chartFn, echartsAdapter, type ChartSpec } from "chartfn";

const api = chartFn({
  defaultAdapter: "echarts",
  adapters: { echarts: echartsAdapter },
});

const spec: ChartSpec = {
  type: "bar",
  data: { series: [{ name: "A", values: [1, 2, 3] }] },
};

export function Dashboard() {
  return <Chart spec={spec} api={api} />;
}
```

## Svelte binding

```svelte
<script lang="ts">
  import { Chart } from "@chartfn/svelte";
  import { chartFn, echartsAdapter, type ChartSpec } from "chartfn";

  const api = chartFn({
    defaultAdapter: "echarts",
    adapters: { echarts: echartsAdapter },
  });

  const spec: ChartSpec = {
    type: "bar",
    data: { series: [{ name: "A", values: [1, 2, 3] }] },
  };
</script>

<Chart {spec} {api} />
```

## Observability

- In production, ChartFn MUST NOT log full `data.series` values.
- Debug logs MAY include adapter name, spec type, error code, and error path.

## Compatibility / Versioning

- ChartSpec v1 is stable. Breaking changes must introduce a new version field and a documented deprecation period before removing the previous version.
- ChartAdapter interface is additive-only for optional methods.
- Packages follow SemVer.

> Note: We recommend using `Apache ECharts` for charting needs.


## Verification

From the repository root, run `npm run build --workspace chartfn`,
`npm test --workspace chartfn`, and `npm run typecheck --workspace chartfn`.
`node chartfn/scripts/packed-consumer.mjs` validates installed tarball imports,
SSR rendering and Node16/NodeNext TypeScript declarations.

`node chartfn/scripts/browser-acceptance.mjs` checks actual vendor rendering and
exports; `node chartfn/scripts/framework-browser-acceptance.mjs` checks packed
React/Svelte consumers. These browser scripts require Playwright and Chromium.
Set `PLAYWRIGHT_MODULE_PATH` to an installed Playwright module and optionally
`BROWSER_EXECUTABLE_PATH` to a Chromium executable. Both scripts close their
disposable browser contexts and local servers when they finish.

`node chartfn/scripts/determinism-acceptance.mjs` compares rendered pixels from two
independent mounts for all seven chart types and all three vendors with animations
disabled. This checks repeatability within the selected browser/vendor versions,
not identical output across browsers, fonts, operating systems, or library versions.
The numbered requirement and original intent coverage is recorded in
`.conduct/requirement-readiness.md`, including the imperative-handle error-contract
qualification and separate hosted CI gates.
