<script lang="ts">
  interface Props {
    for?: string;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { for: htmlFor, children, class: className, ...rest }: Props = $props();

  function handleMouseDown(event: MouseEvent) {
    if (!event.defaultPrevented && event.detail > 1) {
      event.preventDefault();
    }
  }
</script>

<label
  for={htmlFor}
  onmousedown={handleMouseDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</label>
