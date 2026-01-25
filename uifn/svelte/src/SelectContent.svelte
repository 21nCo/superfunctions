<script lang="ts">
  import { getContext } from 'svelte';
  import { portal } from './internal/portal';
  import { position, type Side, type Align } from './internal/position';
  import { focusTrap } from './internal/focus-trap';

  interface Props {
    children?: import('svelte').Snippet;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    alignOffset?: number;
    position?: 'item-aligned' | 'popper';
    [key: string]: any;
  }

  let { 
    children, 
    side = 'bottom', 
    align = 'start', 
    sideOffset = 0, 
    alignOffset = 0,
    position: positionMode = 'item-aligned',
    ...rest 
  }: Props = $props();

  const ctx = getContext<any>('select');

  function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
          e.preventDefault();
          ctx.setOpen(false);
      }
  }
</script>

{#if ctx.open}
  <div use:portal>
    <div
      role="listbox"
      id="select-content"
      data-state={ctx.open ? 'open' : 'closed'}
      use:position={{
        trigger: ctx.trigger,
        side,
        align,
        sideOffset,
        alignOffset
      }}
      use:focusTrap={{ active: true, returnFocus: true }}
      style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); min-width: 100px;"
      {...rest}
      onkeydown={handleKeyDown}
      tabindex="-1"
    >
      {@render children?.()}
    </div>
  </div>
{/if}
