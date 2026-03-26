<script lang="ts">
  import { createSelect } from '@uifn/core/primitives/select';
  import type { SelectOption } from '@uifn/core/primitives/select';
  import { setContext } from 'svelte';
  import { createSveltePublicId } from './internal/id';

  interface SelectContext {
    value: string;
    open: boolean;
    disabled: boolean;
    required: boolean;
    contentId: string;
    highlightedItem: string | null;
    trigger: HTMLElement | null;
    setValue: (value: string) => void;
    setOpen: (value: boolean) => void;
    registerTrigger: (el: HTMLElement) => void;
    registerOption: (option: SelectOption) => void;
    unregisterOption: (value: string) => void;
    registerOptionElement: (value: string, element: HTMLElement) => void;
    unregisterOptionElement: (value: string) => void;
    getOptionId: (value: string) => string | undefined;
    focusOption: (value: string | null | undefined) => void;
    handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  }

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
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue)();
  const initialOpen = (() => openProp)();
  const initialDefaultOpen = (() => defaultOpen)();
  const initialDisabled = (() => disabled)();
  const initialRequired = (() => required)();
  const notifyValueChange = (value: string) => onValueChange?.(value);
  const notifyOpenChange = (open: boolean) => onOpenChange?.(open);
  const contentId = createSveltePublicId(undefined, {
    prefix: 'select',
    slot: 'content',
  });

  const machine = createSelect({
    value: initialValue,
    defaultValue: initialDefaultValue,
    onValueChange: notifyValueChange,
    open: initialOpen,
    defaultOpen: initialDefaultOpen,
    onOpenChange: notifyOpenChange,
    disabled: initialDisabled,
    required: initialRequired
  });

  let state = $state(machine.state);
  let triggerElement = $state<HTMLElement | null>(null);
  let options = $state<SelectOption[]>([]);
  const optionElements = new Map<string, HTMLElement>();
  const optionIds = new Map<string, string>();
  let previousOpen = initialOpen ?? initialDefaultOpen ?? false;

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
    if (!optionIds.has(option.value)) {
      optionIds.set(
        option.value,
        createSveltePublicId(undefined, {
          prefix: 'select-option',
          slot: option.value,
        })
      );
    }
    machine.actions.setOptions(options);
  }

  function unregisterOption(value: string) {
    options = options.filter((entry) => entry.value !== value);
    optionIds.delete(value);
    machine.actions.setOptions(options);
  }

  function registerOptionElement(value: string, element: HTMLElement) {
    optionElements.set(value, element);
  }

  function unregisterOptionElement(value: string) {
    optionElements.delete(value);
  }

  function getOptionId(optionValue: string) {
    return optionIds.get(optionValue);
  }

  function focusOption(optionValue: string | null | undefined) {
    if (!optionValue) {
      return;
    }

    optionElements.get(optionValue)?.focus();
  }

  function handleKeyDown(key: string, currentItem?: string | null) {
    return machine.actions.handleKeyDown(key, currentItem);
  }

  $effect(() => {
    if (previousOpen && !isOpen) {
      queueMicrotask(() => {
        triggerElement?.focus();
      });
    }

    previousOpen = isOpen;
  });

  setContext<SelectContext>('select', {
    get value() { return value; },
    get open() { return isOpen; },
    get disabled() { return disabled; },
    get required() { return required; },
    get contentId() { return contentId; },
    get highlightedItem() { return state.highlightedItem; },
    get trigger() { return triggerElement; },
    setValue,
    setOpen,
    registerTrigger,
    registerOption,
    unregisterOption,
    registerOptionElement,
    unregisterOptionElement,
    getOptionId,
    focusOption,
    handleKeyDown
  });
</script>

{@render children?.()}
<input type="hidden" {name} {value} {required} {disabled} />
