<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();

  const context = getContext<any>('collapsible');
</script>

<div
  data-state={context.open ? 'open' : 'closed'}
  data-disabled={context.disabled ? '' : undefined}
  hidden={!context.open}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
