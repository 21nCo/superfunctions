<script lang="ts">
  import { getRequiredContext } from './internal/context';
  import { focusTrap } from './internal/focus-trap';
  import { lockBodyScroll } from './internal/body-scroll-lock';

  interface Props {
    children?: import('svelte').Snippet;
    onOpenAutoFocus?: (e: Event) => void;
    onCloseAutoFocus?: (e: Event) => void;
    onEscapeKeyDown?: (e: KeyboardEvent) => void;
    [key: string]: any;
  }

  let { 
    children, 
    onOpenAutoFocus, 
    onCloseAutoFocus, 
    onEscapeKeyDown, 
    ...rest 
  }: Props = $props();

  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogContent',
    'AlertDialog components must be used within AlertDialog'
  );
  let contentEl: HTMLDivElement;
  
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onEscapeKeyDown?.(e);
      if (!e.defaultPrevented) {
        ctx.setOpen(false);
      }
    }
  }

  $effect(() => {
    if (!ctx.open) {
      return;
    }

    return lockBodyScroll();
  });

  $effect(() => {
    if (ctx.open) {
      queueMicrotask(() => {
        contentEl?.focus();
      });
    }
  });
</script>

<div
  bind:this={contentEl}
  role="alertdialog"
  id={`${ctx.baseId}-content`}
  aria-labelledby={`${ctx.baseId}-title`}
  aria-describedby={`${ctx.baseId}-description`}
  aria-modal="true"
  data-state={ctx.open ? 'open' : 'closed'}
  use:focusTrap={{
    active: ctx.open,
    returnFocus: true
  }}
  style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 51;"
  {...rest}
  onkeydown={handleKeyDown}
  tabindex="-1"
>
  {@render children?.()}
</div>
