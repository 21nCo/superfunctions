<script lang="ts">
  import { createAlertDialog } from '@uifn/core/primitives/alert-dialog';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen, onOpenChange, children }: Props = $props();

  const machine = createAlertDialog({
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
      machine.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);
  const baseId = `alert-dialog-${Math.random().toString(36).substr(2, 9)}`;

  setContext('alert-dialog', {
    get open() { return isOpen; },
    setOpen,
    baseId
  });
</script>

{@render children?.()}
