<script lang="ts">
  import { createAlertDialog } from '@uifn/core/primitives/alert-dialog';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen, onOpenChange, children }: Props = $props();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);

  const machine = createAlertDialog({
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange
  });

  let state = $state(machine.state);

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
      machine.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);
  const baseId = createSveltePublicId(undefined, {
    prefix: 'alert-dialog',
    slot: 'root',
  });

  setContext('alert-dialog', {
    get open() { return isOpen; },
    setOpen,
    baseId
  });
</script>

{@render children?.()}
