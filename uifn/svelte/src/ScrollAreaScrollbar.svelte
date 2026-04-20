<script lang="ts">
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ScrollAreaContext {
    metrics: {
      verticalVisible: boolean;
      horizontalVisible: boolean;
    };
  }

  interface ScrollbarContext {
    orientation: 'horizontal' | 'vertical';
  }

  interface Props {
    orientation?: 'horizontal' | 'vertical';
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { orientation = 'vertical', children, class: className, ...rest }: Props = $props();
  const context = getRequiredContext<ScrollAreaContext>(
    'scroll-area',
    'ScrollAreaScrollbar',
    'ScrollAreaScrollbar must be used within a ScrollArea'
  );
  let isVisible = $derived(
    orientation === 'vertical' ? context.metrics.verticalVisible : context.metrics.horizontalVisible
  );

  setContext<ScrollbarContext>('scroll-area-scrollbar', {
    get orientation() { return orientation; }
  });
</script>

{#if isVisible}
  <div
    role="scrollbar"
    data-orientation={orientation}
    class={className}
    style="display: flex; user-select: none; touch-action: none; transition: background 160ms ease-out; position: absolute; {orientation === 'vertical' ? 'right: 0; width: 10px; height: 100%;' : 'bottom: 0; height: 10px; width: 100%;'}"
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
