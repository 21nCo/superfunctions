# @chartfn/svelte

Svelte bindings for `chartfn`.

## Usage

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
