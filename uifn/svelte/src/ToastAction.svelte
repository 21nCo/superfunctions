<script lang="ts">
  interface Props {
    altText: string;
    children?: import('svelte').Snippet;
    class?: string;
  }
  let { altText, children, class: className, ...rest }: Props = $props();
</script>

<button
  type="button"
  class={className}
  style="grid-area: action;"
  {...rest}
>
  {@render children?.()}
</button>
