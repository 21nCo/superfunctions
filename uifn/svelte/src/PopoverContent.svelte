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

  const context = getContext<any>('popover');

  // Simple outside click handling
  function handleOutsideClick(e: MouseEvent) {
    if (context.open && !context.modal) {
        // Implementation would need a ref to the content.
    }
  }
</script>

{#if context.open}
  <div 
    use:portalAction={'body'}
    use:positionAction={{
        trigger: context.triggerElement,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    data-state="open"
    class={className}
    style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 10px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
