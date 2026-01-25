export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  required?: boolean;
}

export interface SelectState {
  value: string;
  open: boolean;
  disabled: boolean;
}

export function createSelect(props: SelectProps) {
  const { onValueChange, onOpenChange, disabled = false } = props;
  let value = props.value !== undefined ? props.value : (props.defaultValue ?? '');
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);

  const listeners = new Set<(state: SelectState) => void>();

  const getState = (): SelectState => ({ value, open, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) onValueChange(state.value);
    if (onOpenChange) onOpenChange(state.open);
  };

  const setValue = (newValue: string) => {
    if (disabled) return;
    if (value !== newValue) {
      value = newValue;
      notify();
    }
  };

  const setOpen = (newOpen: boolean) => {
    if (disabled) return;
    if (open !== newOpen) {
      open = newOpen;
      notify();
    }
  };

  return {
    state: getState(),
    actions: {
      setValue,
      setOpen
    },
    subscribe: (callback: (state: SelectState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
