<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }
  let { children, ...rest }: Props = $props();
</script>

<div
  style:padding="5px"
  style:overflow="auto"
  {...rest}
>
  {@render children?.()}
</div>
