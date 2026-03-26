<script lang="ts">
  import { createMenuBar } from '@uifn/core/primitives/menu-bar';
  import { setContext } from 'svelte';

  interface MenuBarContext {
    value: string;
    autoSelect: boolean;
    setValue: (value: string) => void;
    registerTrigger: (value: string, element: HTMLButtonElement) => void;
    unregisterTrigger: (value: string) => void;
    moveFocus: (key: string, currentValue: string, activateMenu: boolean) => string | null;
    close: () => void;
  }

  interface Props {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { 
    value: valueProp, 
    defaultValue = '', 
    onValueChange, 
    children, 
    class: className, 
    ...rest 
  }: Props = $props();
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue)();
  const notifyValueChange = (value: string) => onValueChange?.(value);

  const machine = createMenuBar({
    value: initialValue,
    defaultValue: initialDefaultValue,
    onValueChange: notifyValueChange
  });

  let state = $state(machine.state);
  const triggers = new Map<string, HTMLButtonElement>();

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  $effect(() => {
    if (valueProp !== undefined && valueProp !== state.value) {
      machine.actions.syncValue(valueProp);
    }
  });

  function setValue(val: string) {
    if (valueProp !== undefined) {
      onValueChange?.(val);
    } else {
      machine.actions.setValue(val);
    }
  }

  let currentValue = $derived(valueProp !== undefined ? valueProp : state.value);

  function getOrderedValues(): string[] {
    return Array.from(triggers.keys());
  }

  function registerTrigger(value: string, element: HTMLButtonElement) {
    triggers.set(value, element);
  }

  function unregisterTrigger(value: string) {
    triggers.delete(value);
  }

  function moveFocus(key: string, currentMenuValue: string, activateMenu: boolean): string | null {
    const values = getOrderedValues();
    if (values.length === 0) {
      return null;
    }

    const currentIndex = Math.max(0, values.indexOf(currentMenuValue));
    let nextIndex = currentIndex;

    if (key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % values.length;
    } else if (key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + values.length) % values.length;
    } else if (key === 'Home') {
      nextIndex = 0;
    } else if (key === 'End') {
      nextIndex = values.length - 1;
    } else {
      return null;
    }

    const nextValue = values[nextIndex] ?? null;
    if (!nextValue) {
      return null;
    }

    triggers.get(nextValue)?.focus();
    if (activateMenu) {
      setValue(nextValue);
    }

    return nextValue;
  }

  function close() {
    setValue('');
  }

  setContext<MenuBarContext>('menubar', {
    get value() { return currentValue; },
    get autoSelect() { return !!currentValue; },
    setValue,
    registerTrigger,
    unregisterTrigger,
    moveFocus,
    close
  });
</script>

<div
  role="menubar"
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
