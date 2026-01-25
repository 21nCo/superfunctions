export interface ProgressProps {
  value?: number | null; // null for indeterminate
  max?: number;
  min?: number; // usually 0
  onValueChange?: (value: number | null) => void;
}

export interface ProgressState {
  value: number | null;
  max: number;
}

export function createProgress(props: ProgressProps) {
  const { max = 100, min = 0, onValueChange } = props;
  let value = props.value !== undefined ? props.value : 0;

  const listeners = new Set<(state: ProgressState) => void>();

  const getState = (): ProgressState => ({ value, max });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) {
      onValueChange(state.value);
    }
  };

  const setValue = (newValue: number | null) => {
    if (newValue !== null) {
        // Clamp
        value = Math.min(Math.max(newValue, min), max);
    } else {
        value = null;
    }
    notify();
  };

  return {
    state: getState(),
    setValue,
    subscribe: (callback: (state: ProgressState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
