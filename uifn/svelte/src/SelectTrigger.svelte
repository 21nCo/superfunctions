<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface SelectContext {
    open: boolean;
    disabled: boolean;
    required: boolean;
    contentId: string;
    highlightedItem: string | null;
    registerTrigger: (el: HTMLElement) => void;
    setOpen: (value: boolean) => void;
    focusOption: (value: string | null | undefined) => void;
    handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  }

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<SelectContext>(
    'select',
    'SelectTrigger',
    'Select components must be used within a Select'
  );
  let el: HTMLElement;

  onMount(() => {
    if (el) ctx.registerTrigger(el);
  });

  function handleClick(e: MouseEvent) {
    if (ctx.disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setOpen(!ctx.open);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (ctx.disabled) {
      return;
    }

    const navigationKeys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];
    if (!navigationKeys.includes(e.key)) {
      return;
    }

    e.preventDefault();
    if (!ctx.open) {
      ctx.setOpen(true);
    }
    const nextItem = ctx.handleKeyDown(e.key, ctx.highlightedItem);
    if (nextItem) {
      queueMicrotask(() => {
        ctx.focusOption(nextItem);
      });
    }
  }
</script>

<button
  bind:this={el}
  type="button"
  role="combobox"
  aria-controls={ctx.open ? ctx.contentId : undefined}
  aria-expanded={ctx.open}
  aria-required={ctx.required}
  aria-disabled={ctx.disabled}
  data-state={ctx.open ? 'open' : 'closed'}
  data-disabled={ctx.disabled ? '' : undefined}
  {...rest}
  onclick={handleClick}
  onkeydown={handleKeyDown}
>
  {@render children?.()}
</button>
