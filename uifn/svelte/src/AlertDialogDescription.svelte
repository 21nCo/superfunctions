<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getContext<any>('alert-dialog');
</script>

<p id={`${ctx.baseId}-description`} {...rest}>
  {@render children?.()}
</p>
