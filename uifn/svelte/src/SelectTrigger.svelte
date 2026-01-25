<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('select');
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
</script>

<button
  bind:this={el}
  type="button"
  role="combobox"
  aria-controls="select-content"
  aria-expanded={ctx.open}
  aria-required={ctx.required}
  aria-disabled={ctx.disabled}
  data-state={ctx.open ? 'open' : 'closed'}
  data-disabled={ctx.disabled ? '' : undefined}
  {...rest}
  onclick={handleClick}
>
  {@render children?.()}
</button>
