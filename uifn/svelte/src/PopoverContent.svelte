<script lang="ts">
  import { getRequiredContext } from './internal/context';
  import { focusCollectionItemByDirection } from './internal/collection';
  import { isOutsideEventTarget } from './internal/dismissible';
  import { portal as portalAction } from './internal/portal';
  import { position as positionAction } from './internal/position';
  import type { Side, Align } from './internal/position';

  interface PopoverContext {
    open: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    setOpen: (value: boolean) => void;
  }

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

  const context = getRequiredContext<PopoverContext>(
    'popover',
    'PopoverContent',
    'Popover components must be used within a Popover'
  );
  let contentEl: HTMLDivElement;
  let anchor = $derived(context.triggerElement);

  $effect(() => {
    if (!context.open) {
      return;
    }

    queueMicrotask(() => {
      contentEl?.focus();
    });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!isOutsideEventTarget(target, [contentEl, context.triggerElement])) {
        return;
      }

      context.setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        context.setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  });

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      event.preventDefault();
      focusCollectionItemByDirection(
        contentEl,
        '[tabindex]:not([tabindex="-1"]), button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        document.activeElement as HTMLElement | null,
        event.shiftKey ? 'prev' : 'next'
      );
    }
  }
</script>

{#if context.open && anchor}
  <div 
    bind:this={contentEl}
    use:portalAction={'body'}
    use:positionAction={{
        trigger: anchor,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    id={context.contentId}
    role="dialog"
    aria-modal="false"
    data-state="open"
    tabindex="-1"
    onkeydown={handleKeyDown}
    class={className}
    style="z-index: var(--uifn-floating-layer-z-index, 100); background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 10px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
