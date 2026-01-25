<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    src: string;
    alt?: string;
    onLoadingStatusChange?: (status: 'idle' | 'loading' | 'loaded' | 'error') => void;
    class?: string;
  }

  let { src, alt, onLoadingStatusChange, class: className, ...rest }: Props = $props();

  const context = getContext<any>('avatar');

  let loadingStatus = $state<'idle' | 'loading' | 'loaded' | 'error'>('idle');

  $effect(() => {
    if (!src) {
      loadingStatus = 'error';
      return;
    }

    loadingStatus = 'loading';
    context.setLoading();
    
    const image = new Image();
    image.src = src;
    
    image.onload = () => {
      loadingStatus = 'loaded';
      context.setLoaded();
    };
    
    image.onerror = () => {
      loadingStatus = 'error';
      context.setError();
    };
  });

  $effect(() => {
    onLoadingStatusChange?.(loadingStatus);
  });
</script>

{#if loadingStatus === 'loaded'}
  <img
    {src}
    {alt}
    data-state="loaded"
    class={className}
    {...rest}
  />
{/if}
