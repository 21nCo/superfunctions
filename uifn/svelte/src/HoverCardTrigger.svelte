<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    asChild?: boolean;
    [key: string]: any;
  }

  let { children, asChild, ...rest }: Props = $props();
  const ctx = getContext<any>('hover-card');
  
  let el: HTMLElement;

  onMount(() => {
    if (el) ctx.registerTrigger(el);
  });

  function handleMouseEnter(e: MouseEvent) {
    rest.onmouseenter?.(e);
    ctx.openWithDelay();
  }

  function handleMouseLeave(e: MouseEvent) {
    rest.onmouseleave?.(e);
    ctx.closeWithDelay();
  }

  function handleFocus(e: FocusEvent) {
      rest.onfocus?.(e);
      ctx.openWithDelay();
  }

  function handleBlur(e: FocusEvent) {
      rest.onblur?.(e);
      ctx.closeWithDelay();
  }
</script>

<a
  bind:this={el}
  href={rest.href || "#"}
  data-state={ctx.open ? 'open' : 'closed'}
  {...rest}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  onfocus={handleFocus}
  onblur={handleBlur}
>
  {@render children?.()}
</a>
