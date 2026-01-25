<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('alert-dialog');
</script>

<div
  data-state={ctx.open ? 'open' : 'closed'}
  aria-hidden="true"
  style="position: fixed; inset: 0; z-index: 50; background-color: rgba(0,0,0,0.5);"
  {...rest}
>
  {@render children?.()}
</div>
