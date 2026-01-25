<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const itemCtx = getContext<any>('combobox-item');
</script>

{#if itemCtx?.isSelected}
  <span aria-hidden="true" {...rest}>
    {#if children}
      {@render children()}
    {:else}
      ✓
    {/if}
  </span>
{/if}
