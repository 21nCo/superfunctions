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
    [key: string]: any;
  }

  let { 
    children, 
    side = 'bottom', 
    align = 'start', 
    sideOffset = 0, 
    alignOffset = 0,
    ...rest 
  }: Props = $props();

  const ctx = getContext<any>('combobox');
  
  // Combobox content usually matches width of input
  // Position hook handles basic positioning.
  // We need to attach to input or trigger. Input is usually primary anchor.
  let anchor = $derived(ctx.input || ctx.trigger);
</script>

{#if ctx.open && anchor}
  <div use:portal>
    <div
      role="listbox"
      id="combobox-content"
      data-state={ctx.open ? 'open' : 'closed'}
      use:position={{
        trigger: anchor,
        side,
        align,
        sideOffset,
        alignOffset
      }}
      style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); min-width: 100px; max-height: 300px; overflow-y: auto;"
      {...rest}
    >
      {@render children?.()}
    </div>
  </div>
{/if}
