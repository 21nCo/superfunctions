<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ScrollAreaContext {
    setViewport: (el: HTMLElement) => void;
    updateMetrics: () => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getRequiredContext<ScrollAreaContext>(
    'scroll-area',
    'ScrollAreaViewport',
    'ScrollAreaViewport must be used within a ScrollArea'
  );
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) {
      context.setViewport(ref);
      context.updateMetrics();
    }
  });

  function handleScroll(event: Event) {
    rest.onscroll?.(event);
    context.updateMetrics();
  }
</script>

<div
  bind:this={ref}
  data-uifn-scroll-area-viewport=""
  class={className}
  style="width: 100%; height: 100%; border-radius: inherit; overflow: scroll;"
  {...rest}
  onscroll={handleScroll}
>
  {@render children?.()}
</div>
