<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }
  let { children, ...rest }: Props = $props();
</script>

<a
  style:padding="4px 8px"
  style:text-decoration="none"
  style:color="inherit"
  {...rest}
>
  {@render children?.()}
</a>
