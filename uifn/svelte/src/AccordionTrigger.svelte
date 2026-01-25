<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();

  const item = getContext<any>('accordion-item');
  const accordion = getContext<any>('accordion');

  function handleClick(e: MouseEvent) {
    if (item.disabled) return;
    accordion.toggleItem(item.value);
    onClick?.(e);
  }
</script>

<h3 style="margin: 0">
  <button
    type="button"
    class={className}
    aria-expanded={item.open}
    aria-disabled={item.disabled}
    data-state={item.open ? 'open' : 'closed'}
    data-disabled={item.disabled ? '' : undefined}
    onclick={handleClick}
    {...rest}
  >
    {@render children?.()}
  </button>
</h3>
