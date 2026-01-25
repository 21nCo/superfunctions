<script lang="ts">
  import { getContext } from 'svelte';
  import { portal as portalAction } from './internal/portal';

  interface Props {
    container?: HTMLElement | string;
    children?: import('svelte').Snippet;
  }

  let { container = 'body', children }: Props = $props();
  const context = getContext<any>('dialog');
</script>

{#if context.open}
  <div use:portalAction={container}>
    {@render children?.()}
  </div>
{/if}
