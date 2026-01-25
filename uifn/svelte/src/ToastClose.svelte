<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }
  let { children, class: className, onClick, ...rest }: Props = $props();
  const context = getContext<any>('toast');

  function handleClick(e: MouseEvent) {
    context.setOpen(false);
    onClick?.(e);
  }
</script>

<button
  type="button"
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
