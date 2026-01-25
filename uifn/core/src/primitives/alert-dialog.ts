export interface AlertDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface AlertDialogState {
  open: boolean;
}

export function createAlertDialog(props: AlertDialogProps) {
  // Logic is identical to Dialog, just different role/semantics often
  const { onOpenChange } = props;
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);

  const listeners = new Set<(state: AlertDialogState) => void>();

  const getState = (): AlertDialogState => ({ open });

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

  return {
    state: getState(),
    setOpen,
    subscribe: (callback: (state: AlertDialogState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
