export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  required?: boolean;
  disabled?: boolean;
  onCheckedChange?: (checked: CheckedState) => void;
}

export interface CheckboxState {
  checked: CheckedState;
  disabled: boolean;
}

export function createCheckbox(props: CheckboxProps) {
  const { onCheckedChange, disabled = false } = props;
  let checked = props.checked !== undefined ? props.checked : (props.defaultChecked ?? false);

  const listeners = new Set<(state: CheckboxState) => void>();

  const getState = (): CheckboxState => ({ checked, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onCheckedChange) {
      onCheckedChange(state.checked);
    }
  };

  const setChecked = (newChecked: CheckedState) => {
    if (disabled) return;
    checked = newChecked;
    notify();
  };

  const toggle = () => {
    if (disabled) return;
    setChecked(checked === 'indeterminate' ? true : !checked);
  };

  return {
    state: getState(),
    actions: {
      setChecked,
      toggle
    },
    subscribe: (callback: (state: CheckboxState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
