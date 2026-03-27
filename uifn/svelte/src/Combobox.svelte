<script lang="ts">
  import { createCombobox } from '@uifn/core/primitives/combobox';
  import type { ComboboxItem } from '@uifn/core/primitives/combobox';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface ComboboxContext {
    value: string;
    inputValue: string;
    open: boolean;
    disabled: boolean;
    contentId: string;
    highlightedItem: string | null;
    filteredItems: string[];
    trigger: HTMLElement | null;
    input: HTMLInputElement | null;
    setValue: (value: string) => void;
    setInputValue: (value: string) => void;
    setOpen: (value: boolean) => void;
    setHighlightedItem: (value: string | null) => void;
    registerTrigger: (el: HTMLElement) => void;
    registerInput: (el: HTMLInputElement) => void;
    registerItem: (item: ComboboxItem) => void;
    unregisterItem: (value: string) => void;
    registerItemElement: (value: string, element: HTMLElement) => void;
    unregisterItemElement: (value: string) => void;
    getItemId: (value: string) => string | undefined;
    scrollItemIntoView: (value: string | null | undefined) => void;
    handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  }

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
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue)();
  const initialInputValue = (() => inputValueProp)();
  const initialDefaultInputValue = (() => defaultInputValue)();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const initialDisabled = (() => disabled)();
  const notifyValueChange = (value: string) => onValueChange?.(value);
  const notifyInputValueChange = (inputValue: string) => onInputValueChange?.(inputValue);
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);
  const contentId = createSveltePublicId(undefined, {
    prefix: 'combobox',
    slot: 'content',
  });

  const machine = createCombobox({
    value: initialValue,
    defaultValue: initialDefaultValue,
    inputValue: initialInputValue,
    defaultInputValue: initialDefaultInputValue,
    onValueChange: notifyValueChange,
    onInputValueChange: notifyInputValueChange,
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange,
    disabled: initialDisabled
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);
  let inputElement = $state<HTMLInputElement | null>(null);
  let items = $state<ComboboxItem[]>([]);
  const itemElements = new Map<string, HTMLElement>();
  const itemIds = new Map<string, string>();

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
    if (!itemIds.has(item.value)) {
      itemIds.set(
        item.value,
        createSveltePublicId(undefined, {
          prefix: 'combobox-option',
          slot: item.value,
        })
      );
    }
    machine.actions.setItems(items);
  }

  function unregisterItem(value: string) {
    items = items.filter((entry) => entry.value !== value);
    itemIds.delete(value);
    machine.actions.setItems(items);
  }

  function registerItemElement(value: string, element: HTMLElement) {
    itemElements.set(value, element);
  }

  function unregisterItemElement(value: string) {
    itemElements.delete(value);
  }

  function getItemId(itemValue: string) {
    return itemIds.get(itemValue);
  }

  function scrollItemIntoView(itemValue: string | null | undefined) {
    if (!itemValue) {
      return;
    }

    itemElements.get(itemValue)?.scrollIntoView({ block: 'nearest' });
  }

  function handleKeyDown(key: string, currentItem?: string | null) {
    return machine.actions.handleKeyDown(key, currentItem);
  }

  function setHighlightedItem(value: string | null) {
    machine.actions.setHighlightedItem(value);
  }

  setContext<ComboboxContext>('combobox', {
    get value() { return value; },
    get inputValue() { return inputValue; },
    get open() { return isOpen; },
    get disabled() { return disabled; },
    get contentId() { return contentId; },
    get highlightedItem() { return state.highlightedItem; },
    get filteredItems() { return state.filteredItems; },
    get trigger() { return triggerElement; },
    get input() { return inputElement; },
    setValue,
    setInputValue,
    setOpen,
    setHighlightedItem,
    registerTrigger,
    registerInput,
    registerItem,
    unregisterItem,
    registerItemElement,
    unregisterItemElement,
    getItemId,
    scrollItemIntoView,
    handleKeyDown
  });
</script>

{@render children?.()}
<input type="hidden" {name} {value} {disabled} />
