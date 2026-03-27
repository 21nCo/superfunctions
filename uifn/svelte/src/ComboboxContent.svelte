<script lang="ts">
  import { isOutsideEventTarget } from './internal/dismissible';
  import { getRequiredContext } from './internal/context';
  import { portal } from './internal/portal';
  import { position, type Side, type Align } from './internal/position';

  interface ComboboxContext {
    open: boolean;
    contentId: string;
    trigger: HTMLElement | null;
    input: HTMLInputElement | null;
    setOpen: (value: boolean) => void;
  }

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

  const ctx = getRequiredContext<ComboboxContext>(
    'combobox',
    'ComboboxContent',
    'Combobox components must be used within a Combobox'
  );
  
  // Combobox content usually matches width of input
  // Position hook handles basic positioning.
  // We need to attach to input or trigger. Input is usually primary anchor.
  let anchor = $derived(ctx.input || ctx.trigger);
  let contentEl: HTMLDivElement;

  $effect(() => {
    if (!ctx.open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!isOutsideEventTarget(target, [contentEl, ctx.input, ctx.trigger])) {
        return;
      }

      ctx.setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });
</script>

{#if ctx.open && anchor}
  <div use:portal>
    <div
      bind:this={contentEl}
      role="listbox"
      id={ctx.contentId}
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
