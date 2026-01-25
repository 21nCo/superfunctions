export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  required?: boolean;
  orientation?: 'horizontal' | 'vertical';
  onValueChange?: (value: string) => void;
}

export interface RadioGroupState {
  value: string;
  disabled: boolean;
}

export function createRadioGroup(props: RadioGroupProps) {
  const { onValueChange, disabled = false } = props;
  let value = props.value !== undefined ? props.value : (props.defaultValue ?? '');

  const listeners = new Set<(state: RadioGroupState) => void>();

  const getState = (): RadioGroupState => ({ value, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) {
      onValueChange(state.value);
    }
  };

  const setValue = (newValue: string) => {
    if (disabled) return;
    if (value !== newValue) {
        value = newValue;
        notify();
    }
  };

  return {
    state: getState(),
    actions: {
      setValue
    },
    subscribe: (callback: (state: RadioGroupState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}