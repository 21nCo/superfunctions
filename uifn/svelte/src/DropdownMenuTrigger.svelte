<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface DropdownMenuContext {
    open: boolean;
    contentId: string;
    setOpen: (value: boolean) => void;
    setTriggerElement: (el: HTMLElement) => void;
    setOpenFocusTarget: (value: 'first' | 'last') => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
  }

  let { children, class: className, onClick, onKeyDown, ...rest }: Props = $props();
  const context = getRequiredContext<DropdownMenuContext>(
    'dropdown-menu',
    'DropdownMenuTrigger',
    'DropdownMenu components must be used within a DropdownMenu'
  );
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
      context.setOpenFocusTarget(e.key === 'ArrowUp' ? 'last' : 'first');
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
  aria-controls={context.open ? context.contentId : undefined}
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
