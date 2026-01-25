<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getContext<any>('dialog');
</script>

<h2
  id={context.baseId + '-title'}
  class={className}
  {...rest}
>
  {@render children?.()}
</h2>
