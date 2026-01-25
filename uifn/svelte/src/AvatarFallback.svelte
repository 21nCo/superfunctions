<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    delayMs?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { delayMs, children, class: className, ...rest }: Props = $props();

  const context = getContext<any>('avatar');
  let canRender = $state(delayMs === undefined);

  onMount(() => {
    if (delayMs !== undefined) {
      const timer = setTimeout(() => {
        canRender = true;
      }, delayMs);
      return () => clearTimeout(timer);
    }
  });
</script>

{#if canRender && context.status !== 'loaded'}
  <span
    class={className}
    {...rest}
  >
    {@render children?.()}
  </span>
{/if}
