# Chartfn

The charting library.

## React binding

```tsx
import { Chart } from "@chartfn/react";
import { chartFn, echartsAdapter } from "chartfn";

const api = chartFn({
  defaultAdapter: "echarts",
  adapters: { echarts: echartsAdapter },
});

const spec = {
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
  import { chartFn, echartsAdapter } from "chartfn";

  const api = chartFn({
    defaultAdapter: "echarts",
    adapters: { echarts: echartsAdapter },
  });

  const spec = {
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

- ChartSpec v1 is stable. Breaking changes must introduce a new version field.
- ChartAdapter interface is additive-only for optional methods.
- Packages follow SemVer.

> Note: We recommend using `Apache ECharts` for charting needs.
