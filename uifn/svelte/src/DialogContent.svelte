<script lang="ts">
  import { onMount } from 'svelte';
  import { focusTrap } from './internal/focus-trap';
  import { getRequiredContext } from './internal/context';
  import { lockBodyScroll } from './internal/body-scroll-lock';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onEscapeKeyDown?: (e: KeyboardEvent) => void;
  }

  let { children, class: className, onEscapeKeyDown, ...rest }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogContent',
    'Dialog components must be used within Dialog'
  );
  let contentEl: HTMLDivElement;

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

  $effect(() => {
    if (!(context.open && context.modal)) {
      return;
    }

    return lockBodyScroll();
  });

  $effect(() => {
    if (context.open) {
      queueMicrotask(() => {
        contentEl?.focus();
      });
    }
  });
</script>

<div
  bind:this={contentEl}
  role="dialog"
  id={context.baseId + '-content'}
  aria-modal={context.modal}
  aria-labelledby={context.baseId + '-title'}
  aria-describedby={context.baseId + '-desc'}
  data-state={context.open ? 'open' : 'closed'}
  use:focusTrap={{ active: context.open && context.modal }}
  class={className}
  style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 51; background-color: white; padding: 20px; border-radius: 4px;"
  tabindex="-1"
  {...rest}
>
  {@render children?.()}
</div>
