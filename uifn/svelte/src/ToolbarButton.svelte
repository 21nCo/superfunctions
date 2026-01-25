<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }
  let { children, ...rest }: Props = $props();
</script>

<button
  type="button"
  style:padding="4px 8px"
  {...rest}
>
  {@render children?.()}
</button>
