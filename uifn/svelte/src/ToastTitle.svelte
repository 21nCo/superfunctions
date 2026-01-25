<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }
  let { children, class: className, ...rest }: Props = $props();
</script>

<div
  class={className}
  style="grid-area: title; margin-bottom: 5px; font-weight: 500;"
  {...rest}
>
  {@render children?.()}
</div>
