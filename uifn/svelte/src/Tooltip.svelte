<script lang="ts">
  import { createTooltip } from '@uifn/core/primitives/tooltip';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    delayDuration?: number;
    children?: import('svelte').Snippet;
  }

  let { 
    open: openProp, 
    defaultOpen = false, 
    onOpenChange, 
    delayDuration = 700, 
    children 
  }: Props = $props();

  const machine = createTooltip({
    open: openProp,
    defaultOpen,
    onOpenChange
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement>();
  let timeout: any;

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function handleOpen() {
    if (timeout) clearTimeout(timeout);
    if (delayDuration <= 0) {
      setOpen(true);
    } else {
      timeout = setTimeout(() => {
        setOpen(true);
      }, delayDuration);
    }
  }

  function handleClose() {
    if (timeout) clearTimeout(timeout);
    setOpen(false);
  }

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  setContext('tooltip', {
    get open() { return isOpen; },
    get triggerElement() { return triggerElement; },
    setTriggerElement: (el: HTMLElement) => { triggerElement = el; },
    handleOpen,
    handleClose
  });
</script>

{@render children?.()}
