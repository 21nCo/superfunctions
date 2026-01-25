<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();
  const context = getContext<any>('popover');
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) context.setTriggerElement(ref);
  });

  function handleClick(e: MouseEvent) {
    context.setOpen(!context.open);
    onClick?.(e);
  }
</script>

<button
  bind:this={ref}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={context.open}
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
