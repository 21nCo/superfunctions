export interface MenuBarState {
  value: string;
}

export interface MenuBarActions {
  setValue: (value: string) => void;
  close: () => void;
}

export interface MenuBarMachine {
  state: MenuBarState;
  actions: MenuBarActions;
  subscribe: (callback: (state: MenuBarState) => void) => () => void;
}

export interface CreateMenuBarProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function createMenuBar(props: CreateMenuBarProps = {}): MenuBarMachine {
  const {
    defaultValue = '',
    onValueChange,
  } = props;

  let state: MenuBarState = {
    value: props.value !== undefined ? props.value : defaultValue,
  };

  const listeners = new Set<(state: MenuBarState) => void>();

  const notify = () => {
    listeners.forEach(l => l({ ...state }));
    onValueChange?.(state.value);
  };

  const actions: MenuBarActions = {
    setValue: (value: string) => {
      if (state.value !== value) {
        state.value = value;
        notify();
      }
    },
    close: () => {
      if (state.value !== '') {
        state.value = '';
        notify();
      }
    }
  };

  return {
    state: { ...state },
    actions,
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
