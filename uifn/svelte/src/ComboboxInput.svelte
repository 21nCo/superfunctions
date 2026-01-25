<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('combobox');
  let el: HTMLInputElement;

  onMount(() => {
    if (el) ctx.registerInput(el);
  });

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    ctx.setInputValue(target.value);
  }

  function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!ctx.open) ctx.setOpen(true);
          // Focus move logic would go here or be handled by roving focus in Content
      } else if (e.key === 'Escape') {
          if (ctx.open) {
              e.preventDefault();
              ctx.setOpen(false);
          }
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
  aria-controls="combobox-content"
  aria-disabled={ctx.disabled}
  data-state={ctx.open ? 'open' : 'closed'}
  disabled={ctx.disabled}
  value={ctx.inputValue}
  {...rest}
  oninput={handleInput}
  onkeydown={handleKeyDown}
  onclick={handleClick}
/>
