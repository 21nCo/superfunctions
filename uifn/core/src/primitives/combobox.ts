export interface ComboboxProps {
  value?: string;
  defaultValue?: string;
  inputValue?: string;
  defaultInputValue?: string;
  onValueChange?: (value: string) => void;
  onInputValueChange?: (inputValue: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  filter?: (items: any[], inputValue: string) => any[]; // Typically client-side filter logic
}

export interface ComboboxState {
  value: string;
  inputValue: string;
  open: boolean;
  disabled: boolean;
}

export function createCombobox(props: ComboboxProps) {
  const { onValueChange, onInputValueChange, onOpenChange, disabled = false } = props;
  
  let value = props.value !== undefined ? props.value : (props.defaultValue ?? '');
  let inputValue = props.inputValue !== undefined ? props.inputValue : (props.defaultInputValue ?? '');
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);

  const listeners = new Set<(state: ComboboxState) => void>();

  const getState = (): ComboboxState => ({ value, inputValue, open, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) onValueChange(state.value);
    if (onInputValueChange) onInputValueChange(state.inputValue);
    if (onOpenChange) onOpenChange(state.open);
  };

  const setValue = (newValue: string) => {
    if (disabled) return;
    if (value !== newValue) {
      value = newValue;
      notify();
    }
  };

  const setInputValue = (newInputValue: string) => {
    if (disabled) return;
    if (inputValue !== newInputValue) {
      inputValue = newInputValue;
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
      setInputValue,
      setOpen
    },
    subscribe: (callback: (state: ComboboxState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
