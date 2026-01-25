<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
    onMouseEnter?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, onMouseEnter, ...rest }: Props = $props();
  
  const menubar = getContext<any>('menubar');
  const menu = getContext<any>('menubar-menu');
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) menu.setTriggerElement(ref);
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
</script>

<button
  bind:this={ref}
  type="button"
  role="menuitem"
  aria-haspopup="menu"
  aria-expanded={menu.open}
  data-state={menu.open ? 'open' : 'closed'}
  onclick={handleClick}
  onmouseenter={handleMouseEnter}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
