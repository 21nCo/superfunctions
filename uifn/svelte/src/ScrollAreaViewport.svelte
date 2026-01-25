<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getContext<any>('scroll-area');
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) context.setViewport(ref);
  });
</script>

<div
  bind:this={ref}
  data-uifn-scroll-area-viewport=""
  class={className}
  style="width: 100%; height: 100%; border-radius: inherit; overflow: scroll;"
  {...rest}
>
  {@render children?.()}
</div>
