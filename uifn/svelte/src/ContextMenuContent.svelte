<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { portal as portalAction } from './internal/portal';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getContext<any>('context-menu');

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      context.setOpen(false);
    }
  }
</script>

{#if context.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    use:portalAction={'body'}
    role="menu"
    data-state="open"
    onkeydown={handleKeyDown}
    class={className}
    style="z-index: 50; position: fixed; left: {context.point.x}px; top: {context.point.y}px; background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 5px 0; min-width: 150px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
