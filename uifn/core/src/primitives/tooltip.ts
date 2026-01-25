export interface TooltipProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  skipDelayDuration?: number; // Not implementing skip logic fully yet
  disableHoverableContent?: boolean;
}

export interface TooltipState {
  open: boolean;
}

export function createTooltip(props: TooltipProps) {
  const { onOpenChange, delayDuration = 700 } = props;
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? false);
  let timeoutId: any;

  const listeners = new Set<(state: TooltipState) => void>();

  const getState = (): TooltipState => ({ open });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onOpenChange) {
      onOpenChange(state.open);
    }
  };

  const setOpen = (newOpen: boolean) => {
    if (timeoutId) clearTimeout(timeoutId);
    open = newOpen;
    notify();
  };

  const openWithDelay = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (delayDuration <= 0) {
      setOpen(true);
    } else {
      timeoutId = setTimeout(() => {
        setOpen(true);
      }, delayDuration);
    }
  };

  const close = () => {
    if (timeoutId) clearTimeout(timeoutId);
    setOpen(false);
  };

  return {
    state: getState(),
    actions: {
      setOpen,
      openWithDelay,
      close
    },
    subscribe: (callback: (state: TooltipState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
