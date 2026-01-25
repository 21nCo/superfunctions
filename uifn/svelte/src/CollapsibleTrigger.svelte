<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();

  const context = getContext<any>('collapsible');

  function handleClick(e: MouseEvent) {
    context.toggle();
    onClick?.(e);
  }
</script>

<button
  type="button"
  aria-expanded={context.open}
  data-state={context.open ? 'open' : 'closed'}
  data-disabled={context.disabled ? '' : undefined}
  disabled={context.disabled}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
