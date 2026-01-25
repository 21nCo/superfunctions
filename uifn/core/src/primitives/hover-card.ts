export interface HoverCardState {
  open: boolean;
}

export interface HoverCardActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
}

export interface HoverCardMachine {
  state: HoverCardState;
  actions: HoverCardActions;
  subscribe: (callback: (state: HoverCardState) => void) => () => void;
}

export interface CreateHoverCardProps {
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openDelay?: number;
  closeDelay?: number;
}

export function createHoverCard(props: CreateHoverCardProps = {}): HoverCardMachine {
  const {
    defaultOpen = false,
    onOpenChange,
  } = props;

  let state: HoverCardState = {
    open: defaultOpen,
  };

  const listeners = new Set<(state: HoverCardState) => void>();

  const notify = () => {
    listeners.forEach(l => l({ ...state }));
    onOpenChange?.(state.open);
  };

  const actions: HoverCardActions = {
    open: () => {
      if (!state.open) {
        state.open = true;
        notify();
      }
    },
    close: () => {
      if (state.open) {
        state.open = false;
        notify();
      }
    },
    toggle: () => {
      state.open = !state.open;
      notify();
    },
    setOpen: (open: boolean) => {
      if (state.open !== open) {
        state.open = open;
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
