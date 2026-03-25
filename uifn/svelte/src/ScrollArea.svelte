<script lang="ts">
  import { setContext } from 'svelte';

  interface ScrollMetrics {
    viewportWidth: number;
    viewportHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
    verticalVisible: boolean;
    horizontalVisible: boolean;
    verticalThumbSize: number;
    verticalThumbOffset: number;
    horizontalThumbSize: number;
    horizontalThumbOffset: number;
  }

  interface ScrollAreaContext {
    viewport: HTMLElement | undefined;
    metrics: ScrollMetrics;
    setViewport: (el: HTMLElement) => void;
    updateMetrics: () => void;
  }

  interface Props {
    type?: 'auto' | 'always' | 'scroll' | 'hover';
    scrollHideDelay?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { type = 'hover', scrollHideDelay = 600, children, class: className, ...rest }: Props = $props();

  let viewportElement = $state<HTMLElement>();
  let metrics = $state<ScrollMetrics>({
    viewportWidth: 0,
    viewportHeight: 0,
    scrollWidth: 0,
    scrollHeight: 0,
    scrollLeft: 0,
    scrollTop: 0,
    verticalVisible: false,
    horizontalVisible: false,
    verticalThumbSize: 0,
    verticalThumbOffset: 0,
    horizontalThumbSize: 0,
    horizontalThumbOffset: 0,
  });

  function updateMetrics() {
    if (!viewportElement) {
      return;
    }

    const viewportWidth = viewportElement.clientWidth;
    const viewportHeight = viewportElement.clientHeight;
    const scrollWidth = viewportElement.scrollWidth;
    const scrollHeight = viewportElement.scrollHeight;
    const scrollLeft = viewportElement.scrollLeft;
    const scrollTop = viewportElement.scrollTop;
    const verticalVisible = scrollHeight > viewportHeight;
    const horizontalVisible = scrollWidth > viewportWidth;
    const verticalThumbSize =
      verticalVisible && scrollHeight > 0 ? (viewportHeight * viewportHeight) / scrollHeight : 0;
    const horizontalThumbSize =
      horizontalVisible && scrollWidth > 0 ? (viewportWidth * viewportWidth) / scrollWidth : 0;
    const verticalThumbOffset =
      verticalVisible && scrollHeight > viewportHeight
        ? (scrollTop / (scrollHeight - viewportHeight)) * (viewportHeight - verticalThumbSize)
        : 0;
    const horizontalThumbOffset =
      horizontalVisible && scrollWidth > viewportWidth
        ? (scrollLeft / (scrollWidth - viewportWidth)) * (viewportWidth - horizontalThumbSize)
        : 0;

    metrics = {
      viewportWidth,
      viewportHeight,
      scrollWidth,
      scrollHeight,
      scrollLeft,
      scrollTop,
      verticalVisible,
      horizontalVisible,
      verticalThumbSize,
      verticalThumbOffset,
      horizontalThumbSize,
      horizontalThumbOffset,
    };
  }

  setContext<ScrollAreaContext>('scroll-area', {
    get viewport() { return viewportElement; },
    get metrics() { return metrics; },
    setViewport: (el: HTMLElement) => {
      viewportElement = el;
      updateMetrics();
    },
    updateMetrics
  });
</script>

<div
  dir="ltr"
  data-uifn-scroll-area=""
  class={className}
  style="position: relative; overflow: hidden;"
  {...rest}
>
  {@render children?.()}
</div>
