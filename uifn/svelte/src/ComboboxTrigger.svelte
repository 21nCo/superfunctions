<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('combobox');
  let el: HTMLElement;

  onMount(() => {
    if (el) ctx.registerTrigger(el);
  });

  function handleClick(e: MouseEvent) {
    if (ctx.disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setOpen(!ctx.open);
      if (!ctx.open) {
          ctx.input?.focus();
      }
    }
  }
</script>

<button
  bind:this={el}
  type="button"
  aria-haspopup="listbox"
  aria-expanded={ctx.open}
  aria-controls="combobox-content"
  data-state={ctx.open ? 'open' : 'closed'}
  data-disabled={ctx.disabled ? '' : undefined}
  disabled={ctx.disabled}
  tabindex="-1"
  {...rest}
  onclick={handleClick}
>
  {@render children?.()}
</button>
