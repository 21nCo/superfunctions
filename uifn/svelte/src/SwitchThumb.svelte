<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();

  const switchContext = getContext<any>('switch');
</script>

<span
  data-state={switchContext.checked ? 'checked' : 'unchecked'}
  data-disabled={switchContext.disabled ? '' : undefined}
  class={className}
  {...rest}
>
  {@render children?.()}
</span>
