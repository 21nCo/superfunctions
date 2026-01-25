export interface ContextMenuProps {
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

export function createContextMenu(props: ContextMenuProps) {
  const { onOpenChange, disabled = false } = props;
  let open = false;
  let x = 0;
  let y = 0;

  const listeners = new Set<(state: ContextMenuState) => void>();

  const getState = (): ContextMenuState => ({ open, x, y });

  const notify = () => {
    const state = getState();
    listeners.forEach(l => l(state));
    if (onOpenChange) onOpenChange(state.open);
  };

  const setOpen = (newOpen: boolean, coords?: { x: number, y: number }) => {
    if (disabled) return;
    open = newOpen;
    if (coords) {
        x = coords.x;
        y = coords.y;
    }
    notify();
  };

  return {
    state: getState(),
    actions: {
      setOpen
    },
    subscribe: (callback: (state: ContextMenuState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
