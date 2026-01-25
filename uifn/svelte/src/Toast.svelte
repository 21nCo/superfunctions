<script lang="ts">
  import { createToast } from '@uifn/core/primitives/toast';
  import { setContext, onMount } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    duration?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { 
    open: openProp, 
    defaultOpen = true, 
    onOpenChange, 
    duration = 5000, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();

  const machine = createToast({
    open: openProp,
    defaultOpen,
    onOpenChange
  });

  let state = $state(machine.state);
  let timer: any;

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function startTimer() {
    if (!duration || duration === Infinity) return;
    stopTimer();
    timer = setTimeout(() => {
      setOpen(false);
    }, duration);
  }

  function stopTimer() {
    if (timer) clearTimeout(timer);
  }

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  $effect(() => {
    if (isOpen) startTimer();
    else stopTimer();
  });

  setContext('toast', {
    get open() { return isOpen; },
    setOpen,
    startTimer,
    stopTimer
  });
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <li
    role="status"
    aria-live="polite"
    aria-atomic="true"
    data-state="open"
    onmouseenter={stopTimer}
    onmouseleave={startTimer}
    class={className}
    style="background-color: white; border-radius: 6px; box-shadow: 0 10px 38px -10px rgba(22, 23, 24, 0.35); padding: 15px; display: grid; grid-template-areas: 'title action' 'description action'; grid-template-columns: auto max-content; column-gap: 15px; align-items: center;"
    {...rest}
  >
    {@render children?.()}
  </li>
{/if}
