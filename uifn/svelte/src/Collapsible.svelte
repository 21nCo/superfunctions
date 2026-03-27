<script lang="ts">
  import { createCollapsibleMachine } from '@uifn/core/primitives/collapsible';
  import { setContext } from 'svelte';

  interface Props {
    open?: boolean;
    defaultOpen?: boolean;
    disabled?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    open: openProp,
    defaultOpen = false,
    disabled = false,
    onOpenChange,
    children,
    class: className,
    ...rest
  }: Props = $props();
  const initialDefaultOpen = (() => defaultOpen)();

  // Note: createCollapsibleMachine returns a state machine, but we might want a simpler controllable wrapper
  // similar to Accordion or Switch.
  // The core machine is simple: { disabled: boolean } context, and OPEN/CLOSE events.
  // But standard React implementation uses useControllableState + simple boolean.
  // Let's stick to useControllableState pattern if possible, or wrap the machine.
  // Actually, for consistency with other Svelte primitives I made, let's use a simple reactive object
  // mimicking the "machine" or just managing state.
  
  // Since `createCollapsibleMachine` is XState-like, it might be overkill if we just want open/close.
  // But let's check `collapsible.ts`.
  
  // It has `createCollapsibleMachine`.
  // Let's use a simpler approach for Svelte MVP: controllable state.
  
  // But wait, I should try to reuse core logic.
  // `createCollapsibleMachine` expects `initialOpen`. It doesn't handle "controlled" state update logic (syncing back).
  // The React implementation uses `useControllableState`.
  // I should port `useControllableState` to Svelte or implement similar logic inline.
  // In `Accordion.svelte`, I used `createAccordion`.
  // `Accordion` core has `setValue`, `subscribe`.
  
  // `Collapsible` core (machine) has `send('TOGGLE')`.
  // It doesn't have a `setValue` action exposed directly in the same way as `createAccordion`.
  // `createCollapsibleMachine` returns a `StateMachine` instance.
  // `machine.state` is string ('open' | 'closed').
  
  // Let's implement custom logic here for now to match React's behavior (controlled).
  
  let _open = $state(initialDefaultOpen);
  
  // Derived open state (controlled or uncontrolled)
  let isOpen = $derived(openProp !== undefined ? openProp : _open);
  
  function setOpen(value: boolean) {
    if (openProp === undefined) {
      _open = value;
    }
    onOpenChange?.(value);
  }
  
  function toggle() {
    if (disabled) return;
    setOpen(!isOpen);
  }
  
  setContext('collapsible', {
    get open() { return isOpen; },
    get disabled() { return disabled; },
    toggle
  });
</script>

<div
  data-state={isOpen ? 'open' : 'closed'}
  data-disabled={disabled ? '' : undefined}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
