# @chartfn/react

React bindings for `chartfn`.

## Usage

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

## Hook

```tsx
import { useChart } from "@chartfn/react";
import { chartFn } from "chartfn";

const api = chartFn({ defaultAdapter: "echarts" });

function ChartContainer({ spec }) {
  const { ref } = useChart(spec, { api });
  return <div ref={ref} />;
}
```
