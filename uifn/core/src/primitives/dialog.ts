export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface DialogState {
  open: boolean;
}

export interface DialogActions {
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export interface DialogMachine {
  state: DialogState;
  actions: DialogActions;
  subscribe: (callback: (state: DialogState) => void) => () => void;
}

export function createDialog(props: DialogProps): DialogMachine {
  const { onOpenChange } = props;
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);

  const listeners = new Set<(state: DialogState) => void>();

  const getState = (): DialogState => ({ open });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onOpenChange) {
      onOpenChange(state.open);
    }
  };

  const setOpen = (newOpen: boolean) => {
    open = newOpen;
    notify();
  };

  const toggle = () => {
    setOpen(!open);
  };

  return {
    state: getState(),
    actions: {
      setOpen,
      toggle
    },
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
