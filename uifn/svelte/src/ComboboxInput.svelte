<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ComboboxContext {
    open: boolean;
    disabled: boolean;
    contentId: string;
    inputValue: string;
    highlightedItem: string | null;
    registerInput: (el: HTMLInputElement) => void;
    setInputValue: (value: string) => void;
    setOpen: (value: boolean) => void;
    getItemId: (value: string) => string | undefined;
    scrollItemIntoView: (value: string | null | undefined) => void;
    handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  }

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<ComboboxContext>(
    'combobox',
    'ComboboxInput',
    'Combobox components must be used within a Combobox'
  );
  let el: HTMLInputElement;

  onMount(() => {
    if (el) ctx.registerInput(el);
  });

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    ctx.setInputValue(target.value);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'].includes(e.key)) {
      return;
    }

    e.preventDefault();
    const nextItem = ctx.handleKeyDown(e.key, ctx.highlightedItem);
    if (nextItem) {
      queueMicrotask(() => {
        ctx.scrollItemIntoView(nextItem);
      });
    }
  }

  function handleClick() {
      if (!ctx.open) ctx.setOpen(true);
  }
</script>

<input
  bind:this={el}
  type="text"
  role="combobox"
  aria-autocomplete="list"
  aria-expanded={ctx.open}
  aria-controls={ctx.open ? ctx.contentId : undefined}
  aria-activedescendant={ctx.open && ctx.highlightedItem ? ctx.getItemId(ctx.highlightedItem) : undefined}
  aria-disabled={ctx.disabled}
  data-state={ctx.open ? 'open' : 'closed'}
  disabled={ctx.disabled}
  value={ctx.inputValue}
  {...rest}
  oninput={handleInput}
  onkeydown={handleKeyDown}
  onclick={handleClick}
/>
