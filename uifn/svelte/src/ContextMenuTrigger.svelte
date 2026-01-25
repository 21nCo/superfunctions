<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onContextMenu?: (e: MouseEvent) => void;
  }

  let { children, class: className, onContextMenu, ...rest }: Props = $props();
  const context = getContext<any>('context-menu');

  function handleContextMenu(e: MouseEvent) {
    onContextMenu?.(e);
    if (!e.defaultPrevented) {
      e.preventDefault();
      context.setPoint({ x: e.clientX, y: e.clientY });
      context.setOpen(true);
    }
  }
</script>

<div
  oncontextmenu={handleContextMenu}
  class={className}
  style="display: contents;"
  {...rest}
>
  {@render children?.()}
</div>
