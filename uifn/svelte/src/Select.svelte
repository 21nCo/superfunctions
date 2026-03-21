<script lang="ts">
  import { createSelect } from '@uifn/core/primitives/select';
  import type { SelectOption } from '@uifn/core/primitives/select';
  import { setContext } from 'svelte';

  interface Props {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    children?: import('svelte').Snippet;
  }

  let { 
    value: valueProp, 
    defaultValue, 
    onValueChange, 
    open: openProp, 
    defaultOpen, 
    onOpenChange, 
    disabled = false,
    required = false,
    name,
    children 
  }: Props = $props();

  const machine = createSelect({
    value: valueProp,
    defaultValue,
    onValueChange,
    open: openProp,
    defaultOpen,
    onOpenChange,
    disabled,
    required
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);
  let options = $state<SelectOption[]>([]);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  $effect(() => {
    if (valueProp !== undefined && state.value !== valueProp) {
      machine.actions.syncValue(valueProp);
    }
  });

  $effect(() => {
    if (openProp !== undefined && state.open !== openProp) {
      machine.actions.syncOpen(openProp);
    }
  });

  // Derived state handling
  let value = $derived(valueProp !== undefined ? valueProp : state.value);
  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  function setValue(val: string) {
    if (valueProp !== undefined) {
      onValueChange?.(val);
    } else {
      machine.actions.setValue(val);
    }
    // Close on selection usually
    setOpen(false);
  }

  function setOpen(val: boolean) {
    if (openProp !== undefined) {
      onOpenChange?.(val);
    } else {
      machine.actions.setOpen(val);
    }
  }

  function registerTrigger(el: HTMLElement) {
    triggerElement = el;
  }

  function registerOption(option: SelectOption) {
    const existingIndex = options.findIndex((entry) => entry.value === option.value);
    if (existingIndex === -1) {
      options = [...options, option];
    } else {
      options = options.map((entry, index) => (index === existingIndex ? option : entry));
    }
    machine.actions.setOptions(options);
  }

  function unregisterOption(value: string) {
    options = options.filter((entry) => entry.value !== value);
    machine.actions.setOptions(options);
  }

  setContext('select', {
    get value() { return value; },
    get open() { return isOpen; },
    get disabled() { return disabled; },
    get trigger() { return triggerElement; },
    setValue,
    setOpen,
    registerTrigger,
    registerOption,
    unregisterOption
  });
</script>

{@render children?.()}
<input type="hidden" {name} {value} {required} {disabled} />
