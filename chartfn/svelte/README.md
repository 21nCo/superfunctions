# @chartfn/svelte

Svelte 5 bindings for `chartfn`. Spec changes update the mounted chart; changing the API or adapter replaces it, and unmount disposes it.

## Usage

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

<Chart {spec} {api} style="width:100%;height:400px" />
```
