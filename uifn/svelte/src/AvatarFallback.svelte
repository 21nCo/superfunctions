<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface AvatarContext {
    status: 'idle' | 'loading' | 'loaded' | 'error';
  }

  interface Props {
    delayMs?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { delayMs, children, class: className, ...rest }: Props = $props();

  const context = getRequiredContext<AvatarContext>(
    'avatar',
    'AvatarFallback',
    'AvatarFallback must be used within an Avatar'
  );
  const initialCanRender = (() => delayMs === undefined)();
  let canRender = $state(initialCanRender);

  onMount(() => {
    // The fallback delay is part of the public helper contract.
    if (delayMs !== undefined) {
      const timer = setTimeout(() => {
        canRender = true;
      }, delayMs);
      return () => clearTimeout(timer);
    }
  });
</script>

{#if canRender && context.status !== 'loaded'}
  <span
    class={className}
    {...rest}
  >
    {@render children?.()}
  </span>
{/if}
