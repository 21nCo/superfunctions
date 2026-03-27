<script lang="ts">
  import { createToggle } from '@uifn/core/primitives/toggle';

  interface Props {
    pressed?: boolean;
    defaultPressed?: boolean;
    disabled?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    pressed: pressedProp,
    defaultPressed,
    disabled = false,
    onPressedChange,
    children,
    class: className,
    ...rest
  }: Props = $props();
  const initialPressed = (() => pressedProp)();
  const initialDefaultPressed = (() => defaultPressed)();
  const initialDisabled = (() => disabled)();
  const notifyPressedChange = (pressed: boolean) => onPressedChange?.(pressed);

  const machine = createToggle({
    pressed: initialPressed,
    defaultPressed: initialDefaultPressed,
    disabled: initialDisabled,
    onPressedChange: notifyPressedChange
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  $effect(() => {
    if (pressedProp !== undefined && pressedProp !== state.pressed) {
      machine.actions.syncPressed(pressedProp);
    }
  });

  function handleClick() {
    if (disabled) return;
    machine.actions.toggle();
  }
</script>

<button
  type="button"
  aria-pressed={state.pressed}
  data-state={state.pressed ? 'on' : 'off'}
  data-disabled={disabled ? '' : undefined}
  disabled={disabled}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
