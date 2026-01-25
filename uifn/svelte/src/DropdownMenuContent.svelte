<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { portal as portalAction } from './internal/portal';
  import { position as positionAction } from './internal/position';
  import type { Side, Align } from './internal/position';

  interface Props {
    side?: Side;
    align?: Align;
    sideOffset?: number;
    alignOffset?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { 
    side = 'bottom', 
    align = 'center', 
    sideOffset = 5, 
    alignOffset = 0, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();

  const context = getContext<any>('dropdown-menu');

  function handleKeyDown(e: KeyboardEvent) {
    // Basic menu navigation ideally here or managed by a roving focus utility
    if (e.key === 'Escape') {
      context.setOpen(false);
    }
  }

  onMount(() => {
    // Click outside logic would go here
  });
</script>

{#if context.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    use:portalAction={'body'}
    use:positionAction={{
        trigger: context.triggerElement,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    role="menu"
    data-state="open"
    onkeydown={handleKeyDown}
    class={className}
    style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 5px 0; min-width: 150px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
