<script lang="ts">
  import { createSlider } from '@uifn/core/primitives/slider';
  import { setContext } from 'svelte';

  interface Props {
    value?: number[];
    defaultValue?: number[];
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    orientation?: 'horizontal' | 'vertical';
    onValueChange?: (value: number[]) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    value: valueProp,
    defaultValue,
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    orientation = 'horizontal',
    onValueChange,
    children,
    class: className,
    ...rest
  }: Props = $props();
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue)();
  const initialMin = (() => min)();
  const initialMax = (() => max)();
  const initialStep = (() => step)();
  const initialDisabled = (() => disabled)();
  const initialOrientation = (() => orientation)();
  const notifyValueChange = (value: number[]) => onValueChange?.(value);

  const machine = createSlider({
    value: initialValue,
    defaultValue: initialDefaultValue,
    min: initialMin,
    max: initialMax,
    step: initialStep,
    disabled: initialDisabled,
    orientation: initialOrientation,
    onValueChange: notifyValueChange
  });

  let state = $state(machine.state);

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

  // Helper to update specific thumb
  function updateThumb(index: number, val: number) {
    const nextValues = [...state.value];
    nextValues[index] = val;
    machine.actions.setValue(nextValues);
  }

  setContext('slider', {
    get value() { return state.value; },
    get min() { return min; },
    get max() { return max; },
    get step() { return step; },
    get orientation() { return orientation; },
    get disabled() { return state.disabled; },
    updateThumb
  });
</script>

<span
  role="group"
  dir="ltr"
  data-orientation={orientation}
  data-disabled={disabled ? '' : undefined}
  style="position: relative; display: flex; align-items: center; user-select: none; touch-action: none; {orientation === 'horizontal' ? 'width: 100%; height: 20px;' : 'flex-direction: column; width: 20px; height: 100%;'}"
  class={className}
  {...rest}
>
  {@render children?.()}
</span>
