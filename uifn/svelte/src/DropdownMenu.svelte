<script lang="ts">
  import { createDropdownMenu } from '@uifn/core/primitives/dropdown-menu';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
  }

  let { open: openProp, defaultOpen = false, onOpenChange, children }: Props = $props();

  const machine = createDropdownMenu({
    open: openProp,
    defaultOpen,
    onOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement>();

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

  setContext('dropdown-menu', {
    get open() { return isOpen; },
    get triggerElement() { return triggerElement; },
    setOpen,
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; }
  });
</script>

{@render children?.()}
