export type ToggleGroupType = 'single' | 'multiple';

export interface ToggleGroupProps {
  type?: ToggleGroupType;
  value?: string | string[];
  defaultValue?: string | string[];
  disabled?: boolean;
  onValueChange?: (value: string | string[]) => void;
}

export interface ToggleGroupState {
  value: string | string[];
}

export interface ToggleGroupActions {
  setValue: (value: string | string[]) => void;
  toggleItem: (itemValue: string) => void;
}

export interface ToggleGroupMachine {
  state: ToggleGroupState;
  actions: ToggleGroupActions;
  subscribe: (callback: (state: ToggleGroupState) => void) => () => void;
}

export function createToggleGroup(props: ToggleGroupProps): ToggleGroupMachine {
  const {
    type = 'single',
    onValueChange
  } = props;

  let value = props.value !== undefined ? props.value : (props.defaultValue ?? (type === 'multiple' ? [] : ''));

  // Normalize initial value
  if (type === 'multiple' && !Array.isArray(value)) {
    value = [value as string];
  } else if (type === 'single' && Array.isArray(value)) {
    value = value[0] || '';
  }

  const listeners = new Set<(state: ToggleGroupState) => void>();

  const getState = (): ToggleGroupState => ({ value });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) {
      onValueChange(state.value);
    }
  };

  const setValue = (newValue: string | string[]) => {
    value = newValue;
    notify();
  };

  const toggleItem = (itemValue: string) => {
    if (type === 'single') {
      const currentValue = value as string;
      if (currentValue === itemValue) {
        // In toggle group, unlike radio group, usually single mode allows deselecting if it acts like a toggle.
        // Spec: "Toggle Group... single or multiple selection."
        // Usually single selection in toggle group allows 0 items if not "mandatory".
        // The spec doesn't specify "mandatory". I'll assume it's like a radio group but unselectable?
        // Or unselectable by default.
        setValue('');
      } else {
        setValue(itemValue);
      }
    } else {
      const currentValues = value as string[];
      if (currentValues.includes(itemValue)) {
        setValue(currentValues.filter(v => v !== itemValue));
      } else {
        setValue([...currentValues, itemValue]);
      }
    }
  };

  return {
    state: getState(),
    actions: {
      setValue,
      toggleItem
    },
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
