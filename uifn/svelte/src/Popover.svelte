<script lang="ts">
  import { createPopover } from '@uifn/core/primitives/popover';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen = false, onOpenChange, modal = false, children }: Props = $props();

  const machine = createPopover({
    open: openProp,
    defaultOpen,
    onOpenChange
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);
  
  let triggerElement = $state<HTMLElement | undefined>();

  setContext('popover', {
    get open() { return isOpen; },
    get modal() { return modal; },
    get triggerElement() { return triggerElement; },
    setOpen,
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
  });
</script>

{@render children?.()}
