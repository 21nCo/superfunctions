<script lang="ts">
  import { setContext } from 'svelte';

  interface Props {
    type?: 'auto' | 'always' | 'scroll' | 'hover';
    scrollHideDelay?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { type = 'hover', scrollHideDelay = 600, children, class: className, ...rest }: Props = $props();

  let viewportElement = $state<HTMLElement>();

  setContext('scroll-area', {
    get viewport() { return viewportElement; },
    setViewport: (el: HTMLElement) => { viewportElement = el; }
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
