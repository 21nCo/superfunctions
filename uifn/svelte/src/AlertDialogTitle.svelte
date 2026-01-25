<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('alert-dialog');
</script>

<h2 id={`${ctx.baseId}-title`} {...rest}>
  {@render children?.()}
</h2>
