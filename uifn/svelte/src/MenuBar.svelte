<script lang="ts">
  import { createMenuBar } from '@uifn/core/primitives/menu-bar';
  import { setContext } from 'svelte';

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

  const machine = createMenuBar({
    value: valueProp,
    defaultValue,
    onValueChange
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  function setValue(val: string) {
    if (valueProp !== undefined) {
      onValueChange?.(val);
    } else {
      machine.actions.setValue(val);
    }
  }

  let currentValue = $derived(valueProp !== undefined ? valueProp : state.value);

  setContext('menubar', {
    get value() { return currentValue; },
    get autoSelect() { return !!currentValue; },
    setValue
  });
</script>

<div
  role="menubar"
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
