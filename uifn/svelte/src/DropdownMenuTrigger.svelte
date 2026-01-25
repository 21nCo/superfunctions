<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
  }

  let { children, class: className, onClick, onKeyDown, ...rest }: Props = $props();
  const context = getContext<any>('dropdown-menu');
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) context.setTriggerElement(ref);
  });

  function handleClick(e: MouseEvent) {
    context.setOpen(!context.open);
    onClick?.(e);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!context.open) context.setOpen(true);
    }
    onKeyDown?.(e);
  }
</script>

<button
  bind:this={ref}
  type="button"
  aria-haspopup="menu"
  aria-expanded={context.open}
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
