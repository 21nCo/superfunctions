<script lang="ts">
  import { setContext } from 'svelte';

  interface Props {
    orientation?: 'horizontal' | 'vertical';
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { orientation = 'horizontal', children, ...rest }: Props = $props();

  setContext('toolbar', {
    get orientation() { return orientation; }
  });
</script>

<div
  role="toolbar"
  aria-orientation={orientation}
  data-orientation={orientation}
  style:display="flex"
  style:padding="5px"
  style:gap="5px"
  style:flex-direction={orientation === 'horizontal' ? 'row' : 'column'}
  {...rest}
>
  {@render children?.()}
</div>
