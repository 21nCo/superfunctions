<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { focusTrap } from './internal/focus-trap';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onEscapeKeyDown?: (e: KeyboardEvent) => void;
  }

  let { children, class: className, onEscapeKeyDown, ...rest }: Props = $props();
  const context = getContext<any>('dialog');

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onEscapeKeyDown?.(e);
      if (!e.defaultPrevented) {
        context.setOpen(false);
      }
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });
</script>

<div
  role="dialog"
  aria-modal={context.modal}
  aria-labelledby={context.baseId + '-title'}
  aria-describedby={context.baseId + '-desc'}
  data-state={context.open ? 'open' : 'closed'}
  use:focusTrap={{ active: context.open && context.modal }}
  class={className}
  style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 51; background-color: white; padding: 20px; border-radius: 4px;"
  {...rest}
>
  {@render children?.()}
</div>
