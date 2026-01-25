<script lang="ts">
  import { getContext } from 'svelte';
  import { portal } from './internal/portal';
  import { position, type Side, type Align } from './internal/position';

  interface Props {
    children?: import('svelte').Snippet;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    alignOffset?: number;
    collisionDetection?: boolean;
    [key: string]: any;
  }

  let { 
    children, 
    side = 'bottom', 
    align = 'center', 
    sideOffset = 5, 
    alignOffset = 0,
    collisionDetection = true,
    ...rest 
  }: Props = $props();

  const ctx = getContext<any>('hover-card');

  function handleMouseEnter(e: MouseEvent) {
      rest.onmouseenter?.(e);
      ctx.cancelClose();
  }

  function handleMouseLeave(e: MouseEvent) {
      rest.onmouseleave?.(e);
      ctx.closeWithDelay();
  }
</script>

{#if ctx.open && ctx.trigger}
  <div use:portal>
    <div
      use:position={{
        trigger: ctx.trigger,
        side,
        align,
        sideOffset,
        alignOffset,
        collisionDetection
      }}
      data-state={ctx.open ? 'open' : 'closed'}
      data-side={side}
      data-align={align}
      style="z-index: 50; background-color: white; border: 1px solid #eee; border-radius: 4px; padding: 10px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"
      {...rest}
      onmouseenter={handleMouseEnter}
      onmouseleave={handleMouseLeave}
    >
      {@render children?.()}
    </div>
  </div>
{/if}
