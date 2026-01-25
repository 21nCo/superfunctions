<script lang="ts">
  import { createToggleGroup } from '@uifn/core/primitives/toggle-group';
  import { setContext } from 'svelte';
  import type { ToggleGroupType } from '@uifn/core/primitives/toggle-group';

  interface Props {
    type?: ToggleGroupType;
    value?: string | string[];
    defaultValue?: string | string[];
    disabled?: boolean;
    onValueChange?: (value: string | string[]) => void;
    orientation?: 'horizontal' | 'vertical';
    rovingFocus?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    type = 'single',
    value: valueProp,
    defaultValue,
    disabled = false,
    onValueChange,
    orientation = 'horizontal',
    rovingFocus = true,
    children,
    class: className,
    ...rest
  }: Props = $props();

  const machine = createToggleGroup({
    type,
    value: valueProp,
    defaultValue,
    disabled,
    onValueChange
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  // Sync value prop if changed (for controlled mode)
  $effect(() => {
    if (valueProp !== undefined && valueProp !== state.value) {
      machine.actions.setValue(valueProp);
    }
  });

  setContext('toggle-group', {
    get value() { return state.value; },
    get type() { return type; },
    get disabled() { return disabled; },
    get rovingFocus() { return rovingFocus; },
    get orientation() { return orientation; },
    toggleItem: machine.actions.toggleItem
  });
</script>

<div
  role="group"
  data-orientation={orientation}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
