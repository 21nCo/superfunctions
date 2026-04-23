<script lang="ts">
  import { isOutsideEventTarget } from './internal/dismissible';
  import { getRequiredContext } from './internal/context';
  import { portal as portalAction } from './internal/portal';
  import { position as positionAction, type Side, type Align } from './internal/position';

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
    class?: string;
    [key: string]: any;
  }

  let { 
    children, 
    side = 'bottom', 
    align = 'start', 
    sideOffset = 0, 
    alignOffset = 0,
    class: className,
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
  <div
    bind:this={contentEl}
    role="listbox"
    id={ctx.contentId}
    data-state="open"
    use:portalAction={'body'}
    use:positionAction={{
      trigger: anchor,
      side,
      align,
      sideOffset,
      alignOffset
    }}
    class={className}
    style="z-index: var(--uifn-floating-layer-z-index, 100); background-color: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); min-width: 100px; max-height: 300px; overflow-y: auto;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
