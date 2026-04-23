<script lang="ts">
  import { getContext } from 'svelte';
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
    side = 'top', 
    align = 'center', 
    sideOffset = 5, 
    alignOffset = 0, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();

  const context = getContext<any>('tooltip');
  let anchor = $derived(context.triggerElement);
</script>

{#if context.open && anchor}
  <div 
    use:portalAction={'body'}
    use:positionAction={{
        trigger: anchor,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    role="tooltip"
    data-state="delayed-open"
    class={className}
    style="z-index: 60; pointer-events: none; background-color: black; color: white; border-radius: 4px; padding: 5px 10px; font-size: 12px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
