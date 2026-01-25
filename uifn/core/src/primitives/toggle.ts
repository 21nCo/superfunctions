export interface ToggleProps {
  pressed?: boolean;
  defaultPressed?: boolean;
  disabled?: boolean;
  onPressedChange?: (pressed: boolean) => void;
}

export interface ToggleState {
  pressed: boolean;
  disabled: boolean;
}

export function createToggle(props: ToggleProps) {
  const { onPressedChange, disabled = false } = props;
  let pressed = props.pressed !== undefined ? props.pressed : (props.defaultPressed ?? false);

  const listeners = new Set<(state: ToggleState) => void>();

  const getState = (): ToggleState => ({ pressed, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onPressedChange) {
      onPressedChange(state.pressed);
    }
  };

  const setPressed = (newPressed: boolean) => {
    if (disabled) return;
    pressed = newPressed;
    notify();
  };

  const toggle = () => {
    setPressed(!pressed);
  };

  return {
    state: getState(),
    actions: {
      setPressed,
      toggle
    },
    subscribe: (callback: (state: ToggleState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
