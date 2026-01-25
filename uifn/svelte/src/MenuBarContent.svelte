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
    side = 'bottom', 
    align = 'start', 
    sideOffset = 5, 
    alignOffset = 0, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();

  const menubar = getContext<any>('menubar');
  const menu = getContext<any>('menubar-menu');
</script>

{#if menu.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    use:portalAction={'body'}
    use:positionAction={{
        trigger: menu.triggerElement,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    role="menu"
    data-state="open"
    class={className}
    style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 5px 0; min-width: 150px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
