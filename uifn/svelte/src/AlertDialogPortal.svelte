<script lang="ts">
  import { getContext } from 'svelte';
  import { portal } from './internal/portal';

  interface Props {
    children?: import('svelte').Snippet;
    container?: HTMLElement;
  }

  let { children, container }: Props = $props();
  const ctx = getContext<any>('alert-dialog');
</script>

{#if ctx.open}
  <div use:portal={container}>
    {@render children?.()}
  </div>
{/if}
