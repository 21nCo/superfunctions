<script lang="ts">
  import { createPopover } from '@uifn/core/primitives/popover';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface PopoverContext {
    open: boolean;
    modal: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    setOpen: (value: boolean) => void;
    setTriggerElement: (el: HTMLElement) => void;
  }

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen = false, onOpenChange, modal = false, children }: Props = $props();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);
  const contentId = createSveltePublicId(undefined, {
    prefix: 'popover',
    slot: 'content',
  });

  const machine = createPopover({
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | undefined>();
  let previousOpen = initialOpen ?? initialDefaultOpen;

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  $effect(() => {
    if (openProp !== undefined && openProp !== state.open) {
      machine.actions.syncOpen(openProp);
    }
  });

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  $effect(() => {
    if (previousOpen && !isOpen) {
      queueMicrotask(() => {
        triggerElement?.focus();
      });
    }

    previousOpen = isOpen;
  });

  setContext<PopoverContext>('popover', {
    get open() { return isOpen; },
    get modal() { return modal; },
    get contentId() { return contentId; },
    get triggerElement() { return triggerElement; },
    setOpen,
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
  });
</script>

{@render children?.()}
