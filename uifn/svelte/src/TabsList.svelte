<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    loop?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { loop = true, children, class: className, ...rest }: Props = $props();

  const context = getContext<any>('tabs');
</script>

<div
  role="tablist"
  aria-orientation={context.orientation}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
