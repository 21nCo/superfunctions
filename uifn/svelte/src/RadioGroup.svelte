<script lang="ts">
  import { createRadioGroup } from '@uifn/core/primitives/radio-group';
  import { setContext } from 'svelte';

  interface Props {
    value?: string;
    defaultValue?: string;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    orientation?: 'horizontal' | 'vertical';
    onValueChange?: (value: string) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    value: valueProp,
    defaultValue,
    disabled = false,
    required = false,
    name,
    orientation = 'vertical',
    onValueChange,
    children,
    class: className,
    ...rest
  }: Props = $props();
  const initialValue = (() => valueProp)();
  const initialDefaultValue = (() => defaultValue)();
  const initialDisabled = (() => disabled)();
  const initialRequired = (() => required)();
  const initialOrientation = (() => orientation)();
  const notifyValueChange = (value: string) => onValueChange?.(value);

  const machine = createRadioGroup({
    value: initialValue,
    defaultValue: initialDefaultValue,
    disabled: initialDisabled,
    required: initialRequired,
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

  setContext('radio-group', {
    get value() { return state.value; },
    get disabled() { return state.disabled; },
    get name() { return name; },
    setValue: machine.actions.setValue
  });
</script>

<div
  role="radiogroup"
  aria-required={required}
  aria-orientation={orientation}
  data-disabled={disabled ? '' : undefined}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
