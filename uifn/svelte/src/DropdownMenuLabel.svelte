<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
</script>

<div
  class={className}
  style="padding: 5px 10px; font-size: 12px; color: #666; font-weight: bold;"
  {...rest}
>
  {@render children?.()}
</div>
