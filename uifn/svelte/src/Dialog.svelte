<script lang="ts">
  import { createDialog } from '@uifn/core/primitives/dialog';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen, onOpenChange, modal = true, children }: Props = $props();

  const machine = createDialog({
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

  // Sync prop changes
  $effect(() => {
    if (openProp !== undefined && openProp !== state.open) {
      // machine.actions.setOpen(openProp); // This might cause loop if not careful, but needed for controlled
      // Actually `createDialog` doesn't handle prop updates automatically.
      // We should probably rely on the machine's internal state if uncontrolled, 
      // or override it if controlled.
      // But for this simple machine, let's just use it as state holder.
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

  const baseId = `dialog-${Math.random().toString(36).substr(2, 9)}`;

  setContext('dialog', {
    get open() { return isOpen; },
    get modal() { return modal; },
    setOpen,
    baseId
  });
</script>

{@render children?.()}
