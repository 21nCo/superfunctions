<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }
  let { children, class: className, ...rest }: Props = $props();
</script>

<div
  class={className}
  style="grid-area: description; margin: 0; opacity: 0.8; font-size: 13px;"
  {...rest}
>
  {@render children?.()}
</div>
