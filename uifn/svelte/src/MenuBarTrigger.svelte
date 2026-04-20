<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface MenuBarContext {
    autoSelect: boolean;
    setValue: (value: string) => void;
    registerTrigger: (value: string, element: HTMLButtonElement) => void;
    unregisterTrigger: (value: string) => void;
    moveFocus: (key: string, currentValue: string, activateMenu: boolean) => string | null;
    close: () => void;
  }

  interface MenuBarMenuContext {
    value: string;
    open: boolean;
    contentId: string;
    setTriggerElement: (el: HTMLElement) => void;
    setOpenFocusTarget: (value: 'first' | 'last') => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
    onMouseEnter?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, onMouseEnter, ...rest }: Props = $props();
  
  const menubar = getRequiredContext<MenuBarContext>(
    'menubar',
    'MenuBarTrigger',
    'MenuBarTrigger must be used within a MenuBar'
  );
  const menu = getRequiredContext<MenuBarMenuContext>(
    'menubar-menu',
    'MenuBarTrigger',
    'MenuBarTrigger must be used within a MenuBarMenu'
  );
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) {
      menu.setTriggerElement(ref);
      menubar.registerTrigger(menu.value, ref as HTMLButtonElement);
    }

    return () => {
      menubar.unregisterTrigger(menu.value);
    };
  });

  function handleClick(e: MouseEvent) {
    if (menu.open) {
      menubar.setValue('');
    } else {
      menubar.setValue(menu.value);
    }
    onClick?.(e);
  }

  function handleMouseEnter(e: MouseEvent) {
    if (menubar.autoSelect && !menu.open) {
      menubar.setValue(menu.value);
    }
    onMouseEnter?.(e);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      menu.setOpenFocusTarget('first');
      menubar.setValue(menu.value);
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      menubar.moveFocus(e.key, menu.value, menubar.autoSelect);
      return;
    }

    if (e.key === 'Escape' && menu.open) {
      e.preventDefault();
      menubar.close();
    }
  }
</script>

<button
  bind:this={ref}
  type="button"
  role="menuitem"
  aria-haspopup="menu"
  aria-expanded={menu.open}
  aria-controls={menu.open ? menu.contentId : undefined}
  data-state={menu.open ? 'open' : 'closed'}
  onclick={handleClick}
  onmouseenter={handleMouseEnter}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
