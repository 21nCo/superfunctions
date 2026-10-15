# @chartfn/react

React bindings for `chartfn`. Supports React 16.8 and later. Spec changes update the mounted chart; changing the API or adapter replaces it, and unmount disposes it. React StrictMode is supported.

## Usage

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
  return <Chart spec={spec} api={api} style={{ width: "100%", height: 400 }} />;
}
```

## Hook

```tsx
import { useChart } from "@chartfn/react";
import { chartFn, type ChartSpec } from "chartfn";

const api = chartFn({ defaultAdapter: "echarts" });

function ChartContainer({ spec }: { spec: ChartSpec }) {
  const { ref } = useChart(spec, { api });
  return <div ref={ref} style={{ width: "100%", height: 400 }} />;
}
```
