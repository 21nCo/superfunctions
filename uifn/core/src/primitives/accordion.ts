export type AccordionType = 'single' | 'multiple';

export interface AccordionProps {
  type?: AccordionType;
  value?: string | string[];
  defaultValue?: string | string[];
  collapsible?: boolean;
  disabled?: boolean;
  onValueChange?: (value: string | string[]) => void;
}

export interface AccordionState {
  value: string | string[];
}

export interface AccordionActions {
  setValue: (value: string | string[]) => void;
  toggleItem: (itemValue: string) => void;
}

export interface AccordionMachine {
  state: AccordionState;
  actions: AccordionActions;
  subscribe: (callback: (state: AccordionState) => void) => () => void;
}

export function createAccordion(props: AccordionProps): AccordionMachine {
  const {
    type = 'single',
    collapsible = false,
    onValueChange
  } = props;

  let value = props.value !== undefined ? props.value : (props.defaultValue ?? (type === 'multiple' ? [] : ''));

  // Normalize value
  if (type === 'multiple' && !Array.isArray(value)) {
    value = [value as string];
  } else if (type === 'single' && Array.isArray(value)) {
    value = value[0] || '';
  }

  const listeners = new Set<(state: AccordionState) => void>();

  const getState = (): AccordionState => ({ value });

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
        if (collapsible) {
          setValue('');
        }
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
