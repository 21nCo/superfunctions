<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();

  const item = getContext<any>('accordion-item');
</script>

<div
  class={className}
  role="region"
  data-state={item.open ? 'open' : 'closed'}
  data-disabled={item.disabled ? '' : undefined}
  hidden={!item.open}
  {...rest}
>
  {@render children?.()}
</div>
