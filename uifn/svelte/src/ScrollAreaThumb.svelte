<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface ScrollAreaContext {
    viewport: HTMLElement | undefined;
    metrics: {
      viewportWidth: number;
      viewportHeight: number;
      scrollWidth: number;
      scrollHeight: number;
      horizontalThumbSize: number;
      horizontalThumbOffset: number;
      verticalThumbSize: number;
      verticalThumbOffset: number;
    };
    updateMetrics: () => void;
  }

  interface ScrollbarContext {
    orientation: 'horizontal' | 'vertical';
  }

  interface Props {
    class?: string;
  }
  let { class: className, ...rest }: Props = $props();
  const context = getRequiredContext<ScrollAreaContext>(
    'scroll-area',
    'ScrollAreaThumb',
    'ScrollAreaThumb must be used within a ScrollArea'
  );
  const scrollbar = getRequiredContext<ScrollbarContext>(
    'scroll-area-scrollbar',
    'ScrollAreaThumb',
    'ScrollAreaThumb must be used within a ScrollAreaScrollbar'
  );

  let size = $derived(
    scrollbar.orientation === 'vertical'
      ? context.metrics.verticalThumbSize
      : context.metrics.horizontalThumbSize
  );
  let offset = $derived(
    scrollbar.orientation === 'vertical'
      ? context.metrics.verticalThumbOffset
      : context.metrics.horizontalThumbOffset
  );

  function handlePointerDown(event: PointerEvent) {
    const viewport = context.viewport;
    if (!viewport) {
      return;
    }

    event.preventDefault();
    const startPointer = scrollbar.orientation === 'vertical' ? event.clientY : event.clientX;
    const startScroll = scrollbar.orientation === 'vertical' ? viewport.scrollTop : viewport.scrollLeft;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const currentPointer =
        scrollbar.orientation === 'vertical' ? moveEvent.clientY : moveEvent.clientX;
      const delta = currentPointer - startPointer;

      if (scrollbar.orientation === 'vertical') {
        const track = Math.max(1, context.metrics.viewportHeight - context.metrics.verticalThumbSize);
        const scrollable = Math.max(0, context.metrics.scrollHeight - context.metrics.viewportHeight);
        viewport.scrollTop = startScroll + (delta / track) * scrollable;
      } else {
        const track = Math.max(1, context.metrics.viewportWidth - context.metrics.horizontalThumbSize);
        const scrollable = Math.max(0, context.metrics.scrollWidth - context.metrics.viewportWidth);
        viewport.scrollLeft = startScroll + (delta / track) * scrollable;
      }

      context.updateMetrics();
    };

    const handlePointerUp = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }
</script>

<div
  class={className}
  data-thumb-size={size}
  data-thumb-offset={offset}
  style="background: rgba(0,0,0,0.3); border-radius: 10px; position: relative; {scrollbar.orientation === 'vertical' ? `width: 100%; height: ${size}px; transform: translateY(${offset}px);` : `height: 100%; width: ${size}px; transform: translateX(${offset}px);`}"
  onpointerdown={handlePointerDown}
  {...rest}
></div>
