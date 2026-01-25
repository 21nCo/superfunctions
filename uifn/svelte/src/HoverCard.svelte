<script lang="ts">
  import { createHoverCard } from '@uifn/core/primitives/hover-card';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    openDelay?: number;
    closeDelay?: number;
    children?: import('svelte').Snippet;
  }

  let { 
    open: openProp, 
    defaultOpen, 
    onOpenChange, 
    openDelay = 700, 
    closeDelay = 300,
    children 
  }: Props = $props();

  const machine = createHoverCard({
    defaultOpen,
    onOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  // Derived state handling for controlled vs uncontrolled
  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  let openTimer: any;
  let closeTimer: any;

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  function openWithDelay() {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    if (openDelay <= 0) {
      setOpen(true);
    } else {
      openTimer = setTimeout(() => {
        setOpen(true);
      }, openDelay);
    }
  }

  function closeWithDelay() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (closeDelay <= 0) {
      setOpen(false);
    } else {
      closeTimer = setTimeout(() => {
        setOpen(false);
      }, closeDelay);
    }
  }

  function cancelClose() {
    clearTimeout(closeTimer);
  }

  function registerTrigger(el: HTMLElement) {
    triggerElement = el;
  }

  setContext('hover-card', {
    get open() { return isOpen; },
    get trigger() { return triggerElement; },
    openWithDelay,
    closeWithDelay,
    cancelClose,
    registerTrigger
  });

  $effect(() => {
    return () => {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
    };
  });
</script>

{@render children?.()}
