<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }
  let { children, ...rest }: Props = $props();
</script>

<div style:padding="5px 10px" style:font-size="12px" style:color="#666" {...rest}>
  {@render children?.()}
</div>
