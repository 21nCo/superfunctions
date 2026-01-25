export type ToastType = 'foreground' | 'background';

export interface ToastProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  type?: ToastType;
}

export interface ToastState {
  open: boolean;
}

export function createToast(props: ToastProps) {
  const { onOpenChange, duration = 5000 } = props;
  let open = props.open !== undefined ? props.open : (props.defaultOpen ?? true);
  let timerId: any;

  const listeners = new Set<(state: ToastState) => void>();

  const getState = (): ToastState => ({ open });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onOpenChange) {
      onOpenChange(state.open);
    }
  };

  const setOpen = (newOpen: boolean) => {
    if (open !== newOpen) {
        open = newOpen;
        notify();
    }
  };

  const startTimer = () => {
      if (duration === Infinity) return;
      clearTimeout(timerId);
      timerId = setTimeout(() => setOpen(false), duration);
  };

  const pauseTimer = () => {
      clearTimeout(timerId);
  };

  const resumeTimer = () => {
      startTimer();
  };

  if (open) {
      startTimer();
  }

  return {
    state: getState(),
    actions: {
      setOpen,
      startTimer,
      pauseTimer,
      resumeTimer
    },
    subscribe: (callback: (state: ToastState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}