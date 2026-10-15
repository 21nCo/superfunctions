<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { ChartFnAPI, ChartFnConfig, ChartSpec, ChartAdapterHandle } from "chartfn";
  import { chartFn } from "chartfn";

  export let spec: ChartSpec;
  export let adapter: string | undefined = undefined;
  export let api: ChartFnAPI | undefined = undefined;
  export let config: ChartFnConfig | undefined = undefined;
  export let className: string | undefined = undefined;
  export let style: string | undefined = undefined;

  let container: HTMLDivElement | null = null;
  let mounted = false;
  let binding: { api: ChartFnAPI; adapter?: string; handle: ChartAdapterHandle; spec: ChartSpec } | undefined;
  let resolvedApi: ChartFnAPI | undefined;
  $: resolvedApi = api ?? (config ? chartFn(config) : undefined);

  const syncChart = (ready: boolean, element: HTMLDivElement | null, nextApi: ChartFnAPI | undefined, nextAdapter: string | undefined, nextSpec: ChartSpec) => {
    if (!ready) return;
    if (binding && (binding.api !== nextApi || binding.adapter !== nextAdapter)) {
      binding.handle.dispose();
      binding = undefined;
    }
    if (!nextApi || !element) return;
    if (binding) {
      if (binding.spec !== nextSpec) {
        binding.handle.update(nextSpec);
        binding.spec = nextSpec;
      }
      return;
    }
    const result = nextApi.render(element, nextSpec, nextAdapter ? { adapter: nextAdapter } : undefined);
    if (result.ok) binding = { api: nextApi, adapter: nextAdapter, handle: result.result, spec: nextSpec };
  };

  onMount(() => { mounted = true; });
  $: syncChart(mounted, container, resolvedApi, adapter, spec);
  onDestroy(() => {
    binding?.handle.dispose();
    binding = undefined;
  });

</script>

<div bind:this={container} class={className} style={style}></div>
