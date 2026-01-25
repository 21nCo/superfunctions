export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
}

export interface PopoverState {
  open: boolean;
}

export function createPopover(props: PopoverProps) {
  const { onOpenChange } = props;
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);

  const listeners = new Set<(state: PopoverState) => void>();

  const getState = (): PopoverState => ({ open });

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
    actions: {
      setOpen
    },
    subscribe: (callback: (state: PopoverState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}