<script lang="ts">
  import { createCombobox } from '@uifn/core/primitives/combobox';
  import type { ComboboxItem } from '@uifn/core/primitives/combobox';
  import { setContext } from 'svelte';

  interface Props {
    value?: string;
    defaultValue?: string;
    inputValue?: string;
    defaultInputValue?: string;
    onValueChange?: (value: string) => void;
    onInputValueChange?: (inputValue: string) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    name?: string;
    children?: import('svelte').Snippet;
  }

  let { 
    value: valueProp, 
    defaultValue, 
    inputValue: inputValueProp,
    defaultInputValue,
    onValueChange, 
    onInputValueChange,
    open: openProp, 
    defaultOpen, 
    onOpenChange, 
    disabled = false,
    name,
    children 
  }: Props = $props();

  const machine = createCombobox({
    value: valueProp,
    defaultValue,
    inputValue: inputValueProp,
    defaultInputValue,
    onValueChange,
    onInputValueChange,
    open: openProp,
    defaultOpen,
    onOpenChange,
    disabled
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);
  let inputElement = $state<HTMLInputElement | null>(null);
  let items = $state<ComboboxItem[]>([]);

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
    if (inputValueProp !== undefined && state.inputValue !== inputValueProp) {
      machine.actions.syncInputValue(inputValueProp);
    }
  });

  $effect(() => {
    if (openProp !== undefined && state.open !== openProp) {
      machine.actions.syncOpen(openProp);
    }
  });

  // Derived state
  let value = $derived(valueProp !== undefined ? valueProp : state.value);
  let inputValue = $derived(inputValueProp !== undefined ? inputValueProp : state.inputValue);
  let isOpen = $derived(openProp !== undefined ? openProp : state.open);

  function setValue(val: string) {
    if (valueProp !== undefined) {
      onValueChange?.(val);
    } else {
      machine.actions.setValue(val);
    }
    // Update input value to match selected value?
    // Usually yes for combobox unless multiple selection
    setInputValue(val);
    setOpen(false);
  }

  function setInputValue(val: string) {
    if (inputValueProp !== undefined) {
      onInputValueChange?.(val);
    } else {
      machine.actions.setInputValue(val);
    }
    if (val && !isOpen) {
        setOpen(true);
    }
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

  function registerInput(el: HTMLInputElement) {
    inputElement = el;
  }

  function registerItem(item: ComboboxItem) {
    const existingIndex = items.findIndex((entry) => entry.value === item.value);
    if (existingIndex === -1) {
      items = [...items, item];
    } else {
      items = items.map((entry, index) => (index === existingIndex ? item : entry));
    }
    machine.actions.setItems(items);
  }

  function unregisterItem(value: string) {
    items = items.filter((entry) => entry.value !== value);
    machine.actions.setItems(items);
  }

  setContext('combobox', {
    get value() { return value; },
    get inputValue() { return inputValue; },
    get open() { return isOpen; },
    get disabled() { return disabled; },
    get trigger() { return triggerElement; },
    get input() { return inputElement; },
    setValue,
    setInputValue,
    setOpen,
    registerTrigger,
    registerInput,
    registerItem,
    unregisterItem
  });
</script>

{@render children?.()}
<input type="hidden" {name} {value} {disabled} />
