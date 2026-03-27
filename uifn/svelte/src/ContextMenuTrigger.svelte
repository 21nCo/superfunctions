<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ContextMenuContext {
    setOpen: (value: boolean) => void;
    setPoint: (point: { x: number; y: number }) => void;
    setTriggerElement: (el: HTMLElement) => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onContextMenu?: (e: MouseEvent) => void;
  }

  let { children, class: className, onContextMenu, ...rest }: Props = $props();
  const context = getRequiredContext<ContextMenuContext>(
    'context-menu',
    'ContextMenuTrigger',
    'ContextMenu components must be used within a ContextMenu'
  );
  let ref = $state<HTMLDivElement>();

  onMount(() => {
    if (ref) {
      context.setTriggerElement(ref);
    }
  });

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
  bind:this={ref}
  oncontextmenu={handleContextMenu}
  class={className}
  style="display: contents;"
  {...rest}
>
  {@render children?.()}
</div>
