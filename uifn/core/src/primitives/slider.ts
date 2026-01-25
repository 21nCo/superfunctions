export interface SliderProps {
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  onValueChange?: (value: number[]) => void;
}

export interface SliderState {
  value: number[];
  disabled: boolean;
}

export function createSlider(props: SliderProps) {
  const { 
      min = 0, 
      max = 100, 
      step = 1, 
      onValueChange, 
      disabled = false,
      orientation = 'horizontal'
  } = props;
  
  let value = props.value !== undefined ? props.value : (props.defaultValue ?? [min]);

  const listeners = new Set<(state: SliderState) => void>();

  const getState = (): SliderState => ({ value, disabled });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) onValueChange(state.value);
  };

  const setValue = (newValue: number[]) => {
    if (disabled) return;
    // Clamp values
    const clamped = newValue.map(v => Math.min(Math.max(v, min), max));
    // Check if changed
    if (JSON.stringify(value) !== JSON.stringify(clamped)) {
        value = clamped;
        notify();
    }
  };

  return {
    state: getState(),
    actions: {
      setValue
    },
    options: { min, max, step, orientation },
    subscribe: (callback: (state: SliderState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
