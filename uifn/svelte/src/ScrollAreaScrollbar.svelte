<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    orientation?: 'horizontal' | 'vertical';
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { orientation = 'vertical', children, class: className, ...rest }: Props = $props();
  const context = getContext<any>('scroll-area');
</script>

<div
  role="scrollbar"
  data-orientation={orientation}
  class={className}
  style="display: flex; user-select: none; touch-action: none; transition: background 160ms ease-out; position: absolute; {orientation === 'vertical' ? 'right: 0; width: 10px; height: 100%;' : 'bottom: 0; height: 10px; width: 100%;'}"
  {...rest}
>
  {@render children?.()}
</div>
