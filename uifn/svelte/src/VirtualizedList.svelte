<script lang="ts" generics="T">
  import { onMount } from 'svelte';

  interface Props {
    items: T[];
    itemHeight: number;
    renderItem: (item: T, index: number) => any; // Svelte snippets are tricky to type generically in Props interface currently, using any or specific type if possible.
    // In Svelte 5 snippets are passed as props.
    // However, for generic components, we usually pass a snippet for rendering.
    // Let's assume children is not used, but a specific prop for item rendering snippet.
    // Or we accept a snippet prop `children` that takes { item, index }.
    children: import('svelte').Snippet<[T, number]>;
    height: number | string;
    overscan?: number;
    class?: string;
    style?: string;
    onscroll?: (e: UIEvent) => void;
  }

  let { 
    items, 
    itemHeight, 
    children, 
    height, 
    // Public helper contract: default overscan remains 3.
    overscan = 3, 
    class: className,
    style,
    onscroll,
    ...rest 
  }: Props = $props();

  let scrollTop = $state(0);
  let container: HTMLDivElement;

  let totalHeight = $derived(items.length * itemHeight);
  let viewportHeight = $derived(typeof height === 'number' ? height : 300); // Approximation if string

  let startIndex = $derived(Math.max(0, Math.floor(scrollTop / itemHeight) - overscan));
  let endIndex = $derived(Math.min(
    items.length,
    Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan
  ));

  let visibleItems = $derived(items.slice(startIndex, endIndex).map((item, i) => ({
    item,
    index: startIndex + i
  })));

  function handleScroll(e: UIEvent) {
    scrollTop = (e.target as HTMLElement).scrollTop;
    onscroll?.(e);
  }
</script>

<div
  bind:this={container}
  onscroll={handleScroll}
  class={className}
  style="height: {typeof height === 'number' ? height + 'px' : height}; overflow-y: auto; position: relative; {style}"
  {...rest}
>
  <div style="height: {totalHeight}px; position: relative;">
    {#each visibleItems as { item, index } (index)}
      <div
        style="position: absolute; top: 0; left: 0; width: 100%; height: {itemHeight}px; transform: translateY({index * itemHeight}px);"
      >
        {@render children(item, index)}
      </div>
    {/each}
  </div>
</div>
