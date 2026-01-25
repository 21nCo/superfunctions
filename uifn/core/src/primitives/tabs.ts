export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
}

export interface TabsState {
  value: string;
  orientation: 'horizontal' | 'vertical';
  activationMode: 'automatic' | 'manual';
}

export function createTabs(props: TabsProps) {
  const { 
    onValueChange, 
    orientation = 'horizontal', 
    activationMode = 'automatic' 
  } = props;
  
  let value = props.value !== undefined ? props.value : (props.defaultValue ?? '');

  const listeners = new Set<(state: TabsState) => void>();

  const getState = (): TabsState => ({ value, orientation, activationMode });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onValueChange) {
      onValueChange(state.value);
    }
  };

  const setValue = (newValue: string) => {
    if (value !== newValue) {
        value = newValue;
        notify();
    }
  };

  return {
    state: getState(),
    setValue,
    subscribe: (callback: (state: TabsState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
