<script lang="ts">
  import { focusCollectionItemByDirection } from './internal/collection';
  import { isOutsideEventTarget } from './internal/dismissible';
  import { getRequiredContext } from './internal/context';
  import { portal as portalAction } from './internal/portal';
  import { position as positionAction } from './internal/position';
  import type { Side, Align } from './internal/position';

  interface DropdownMenuContext {
    open: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    openFocusTarget: 'first' | 'last';
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

  const context = getRequiredContext<DropdownMenuContext>(
    'dropdown-menu',
    'DropdownMenuContent',
    'DropdownMenu components must be used within a DropdownMenu'
  );
  let contentEl: HTMLDivElement;
  const itemSelector = '[role="menuitem"]:not([aria-disabled="true"])';

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      context.setOpen(false);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusCollectionItemByDirection(
        contentEl,
        itemSelector,
        document.activeElement as HTMLElement | null,
        'next'
      );
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusCollectionItemByDirection(
        contentEl,
        itemSelector,
        document.activeElement as HTMLElement | null,
        'prev'
      );
      return;
    }

    if (e.key === 'Home') {
      e.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, null, 'first');
      return;
    }

    if (e.key === 'End') {
      e.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, null, 'last');
    }
  }

  $effect(() => {
    if (!context.open) {
      return;
    }

    queueMicrotask(() => {
      focusCollectionItemByDirection(
        contentEl,
        itemSelector,
        null,
        context.openFocusTarget === 'last' ? 'last' : 'first'
      );
    });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!isOutsideEventTarget(target, [contentEl, context.triggerElement])) {
        return;
      }

      context.setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });
</script>

{#if context.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    bind:this={contentEl}
    use:portalAction={'body'}
    use:positionAction={{
        trigger: context.triggerElement,
        side,
        align,
        sideOffset,
        alignOffset
    }}
    id={context.contentId}
    role="menu"
    data-state="open"
    onkeydown={handleKeyDown}
    tabindex="-1"
    class={className}
    style="z-index: 50; background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 5px 0; min-width: 150px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
