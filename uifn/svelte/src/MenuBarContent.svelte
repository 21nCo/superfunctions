<script lang="ts">
  import { setContext } from 'svelte';
  import { focusCollectionItemByDirection } from './internal/collection';
  import { isOutsideEventTarget } from './internal/dismissible';
  import { getRequiredContext } from './internal/context';
  import { portal as portalAction } from './internal/portal';
  import { position as positionAction } from './internal/position';
  import type { Side, Align } from './internal/position';

  interface MenuBarContext {
    setValue: (value: string) => void;
    moveFocus: (key: string, currentValue: string, activateMenu: boolean) => string | null;
    close: () => void;
  }

  interface MenuBarMenuContext {
    value: string;
    open: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    openFocusTarget: 'first' | 'last';
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
    align = 'start', 
    sideOffset = 5, 
    alignOffset = 0, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();

  const menubar = getRequiredContext<MenuBarContext>(
    'menubar',
    'MenuBarContent',
    'MenuBarContent must be used within a MenuBar'
  );
  const menu = getRequiredContext<MenuBarMenuContext>(
    'menubar-menu',
    'MenuBarContent',
    'MenuBarContent must be used within a MenuBarMenu'
  );
  let contentEl: HTMLDivElement;
  let anchor = $derived(menu.triggerElement);
  const itemSelector = '[role="menuitem"]:not([aria-disabled="true"])';

  setContext('dropdown-menu', {
    setOpen: (value: boolean) => {
      if (!value) {
        menubar.close();
      }
    },
  });

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      menubar.close();
      menu.triggerElement?.focus();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, document.activeElement as HTMLElement | null, 'next');
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, document.activeElement as HTMLElement | null, 'prev');
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, null, 'first');
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusCollectionItemByDirection(contentEl, itemSelector, null, 'last');
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      menubar.moveFocus(event.key, menu.value, true);
    }
  }

  $effect(() => {
    if (!menu.open) {
      return;
    }

    queueMicrotask(() => {
      focusCollectionItemByDirection(
        contentEl,
        itemSelector,
        null,
        menu.openFocusTarget === 'last' ? 'last' : 'first'
      );
    });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!isOutsideEventTarget(target, [contentEl, menu.triggerElement])) {
        return;
      }

      menubar.close();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });
</script>

{#if menu.open && anchor}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
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
    id={menu.contentId}
    role="menu"
    data-state="open"
    onkeydown={handleKeyDown}
    tabindex="-1"
    class={className}
    style="z-index: var(--uifn-floating-layer-z-index, 100); background-color: white; border: 1px solid #ccc; border-radius: 4px; padding: 5px 0; min-width: 150px;"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
