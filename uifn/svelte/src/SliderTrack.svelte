<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getContext<any>('slider');
</script>

<span
  data-orientation={context.orientation}
  data-disabled={context.disabled ? '' : undefined}
  style="position: relative; flex-grow: 1; border-radius: 9999px; background-color: #ddd; {context.orientation === 'horizontal' ? 'height: 3px;' : 'width: 3px;'}"
  class={className}
  {...rest}
>
  {@render children?.()}
</span>
