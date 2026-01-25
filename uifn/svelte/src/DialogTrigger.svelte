<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();

  const context = getContext<any>('dialog');

  function handleClick(e: MouseEvent) {
    context.setOpen(true);
    onClick?.(e);
  }
</script>

<button
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
