<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ChartFnAPI, ChartFnConfig, ChartSpec } from "chartfn";
  import { chartFn } from "chartfn";

  export let spec: ChartSpec;
  export let adapter: string | undefined = undefined;
  export let api: ChartFnAPI | undefined = undefined;
  export let config: ChartFnConfig | undefined = undefined;
  export let className: string | undefined = undefined;
  export let style: string | undefined = undefined;

  let container: HTMLDivElement | null = null;
  let handle: { update: (next: ChartSpec) => void; dispose: () => void } | null = null;
  let resolvedApi: ChartFnAPI | undefined = api ?? (config ? chartFn(config) : undefined);

  $: resolvedApi = api ?? (config ? chartFn(config) : undefined);

  const renderChart = () => {
    if (!resolvedApi || !container || !spec) {
      return;
    }

    if (handle) {
      handle.update(spec);
      return;
    }

    const result = resolvedApi.render(container, spec, adapter ? { adapter } : undefined);
    if (result.ok) {
      handle = result.result as typeof handle;
    }
  };

  onMount(() => {
    renderChart();
  });

  $: spec, renderChart();

  onDestroy(() => {
    if (handle) {
      handle.dispose();
      handle = null;
    }
  });
</script>

<div bind:this={container} class={className} style={style}></div>
