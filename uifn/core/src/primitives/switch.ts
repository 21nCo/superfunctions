export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  required?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export interface SwitchState {
  checked: boolean;
  disabled: boolean;
}

export function createSwitch(props: SwitchProps) {
  const { onCheckedChange, disabled = false } = props;
  let checked = props.checked !== undefined ? props.checked : (props.defaultChecked ?? false);

  const listeners = new Set<(state: SwitchState) => void>();

  const getState = (): SwitchState => ({ checked, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onCheckedChange) {
      onCheckedChange(state.checked);
    }
  };

  const setChecked = (newChecked: boolean) => {
    if (disabled) return;
    checked = newChecked;
    notify();
  };

  const toggle = () => {
    setChecked(!checked);
  };

  return {
    state: getState(),
    actions: {
      setChecked,
      toggle
    },
    subscribe: (callback: (state: SwitchState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
