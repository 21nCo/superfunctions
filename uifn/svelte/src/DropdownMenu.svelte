<script lang="ts">
  import { createDropdownMenu } from '@uifn/core/primitives/dropdown-menu';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface DropdownMenuContext {
    open: boolean;
    contentId: string;
    triggerElement: HTMLElement | undefined;
    openFocusTarget: 'first' | 'last';
    setOpen: (value: boolean) => void;
    setTriggerElement: (el: HTMLElement) => void;
    setOpenFocusTarget: (value: 'first' | 'last') => void;
  }

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen = false, onOpenChange, children }: Props = $props();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);
  const contentId = createSveltePublicId(undefined, {
    prefix: 'dropdown-menu',
    slot: 'content',
  });

  const machine = createDropdownMenu({
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement>();
  let openFocusTarget = $state<'first' | 'last'>('first');
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

  setContext<DropdownMenuContext>('dropdown-menu', {
    get open() { return isOpen; },
    get contentId() { return contentId; },
    get triggerElement() { return triggerElement; },
    get openFocusTarget() { return openFocusTarget; },
    setOpen,
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
    ,
    setOpenFocusTarget: (value: 'first' | 'last') => { openFocusTarget = value; }
  });
</script>

{@render children?.()}
