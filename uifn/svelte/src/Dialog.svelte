<script lang="ts">
  import { createDialog } from '@uifn/core/primitives/dialog';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface DialogContext {
    open: boolean;
    modal: boolean;
    baseId: string;
    setOpen: (value: boolean) => void;
    setTriggerElement: (element: HTMLElement) => void;
    triggerElement: HTMLElement | null;
  }

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen, onOpenChange, modal = true, children }: Props = $props();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);

  const machine = createDialog({
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);
  let previousOpen = initialOpen ?? initialDefaultOpen ?? false;

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  // Sync prop changes
  $effect(() => {
    if (openProp !== undefined && openProp !== state.open) {
      machine.actions.syncOpen(openProp);
    }
  });

  // Helper to handle controlled updates correctly
  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  // Derive actual open state
  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  const baseId = createSveltePublicId(undefined, {
    prefix: 'dialog',
    slot: 'root',
  });

  $effect(() => {
    if (previousOpen && !isOpen) {
      queueMicrotask(() => {
        triggerElement?.focus();
      });
    }

    previousOpen = isOpen;
  });

  setContext<DialogContext>('dialog', {
    get open() { return isOpen; },
    get modal() { return modal; },
    setOpen,
    get triggerElement() { return triggerElement; },
    setTriggerElement: (element: HTMLElement) => { triggerElement = element; },
    baseId
  });
</script>

{@render children?.()}
