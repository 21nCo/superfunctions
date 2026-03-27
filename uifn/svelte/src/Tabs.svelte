<script lang="ts">
  import { setContext } from 'svelte';
  import { createTabs } from '@uifn/core/primitives/tabs';
  import { createSveltePublicId } from './internal/id';

  interface Props {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    orientation?: 'horizontal' | 'vertical';
    activationMode?: 'automatic' | 'manual';
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    value: valueProp,
    defaultValue,
    onValueChange,
    orientation = 'horizontal',
    activationMode = 'automatic',
    children,
    class: className,
    ...rest
  }: Props = $props();
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue ?? '')();
  const initialOrientation = (() => orientation)();
  const initialActivationMode = (() => activationMode)();
  const notifyValueChange = (value: string) => onValueChange?.(value);

  const machine = createTabs({
    value: initialValue,
    defaultValue: initialDefaultValue,
    onValueChange: notifyValueChange,
    orientation: initialOrientation,
    activationMode: initialActivationMode,
  });

  let state = $state(machine.state);
  const triggers = new Map<string, HTMLButtonElement>();

  $effect(() => {
    return machine.subscribe((nextState) => {
      state = nextState;
    });
  });

  $effect(() => {
    if (valueProp !== undefined && valueProp !== state.value) {
      machine.actions.syncValue(valueProp);
    }
  });

  let value = $derived(valueProp !== undefined ? valueProp : state.value);

  function setValue(val: string) {
    machine.actions.setValue(val);
  }

  function registerTrigger(value: string, element: HTMLButtonElement, disabled: boolean) {
    triggers.set(value, element);
    machine.actions.registerItem(value, disabled);
  }

  function unregisterTrigger(value: string) {
    triggers.delete(value);
    machine.actions.unregisterItem(value);
  }

  function focusItem(value: string) {
    machine.actions.focusItem(value);
  }

  function handleTriggerKeyDown(key: string, currentItem: string) {
    const nextItem = machine.actions.handleKeyDown(key, currentItem);
    if (nextItem) {
      triggers.get(nextItem)?.focus();
    }
  }

  const baseId = createSveltePublicId(undefined, {
    prefix: 'tabs',
    slot: 'root',
  });

  setContext('tabs', {
    get value() { return value; },
    setValue,
    get orientation() { return orientation; },
    get activationMode() { return activationMode; },
    get focusedItem() { return state.focusedItem; },
    focusItem,
    registerTrigger,
    unregisterTrigger,
    handleTriggerKeyDown,
    baseId
  });
</script>

<div
  data-orientation={orientation}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
