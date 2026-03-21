import { createUIFnError, type UIFnError } from '../errors';
import { type ChangeMeta, createStore } from './shared';

export interface CollapsibleProps {
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface CollapsibleState {
  open: boolean;
  disabled: boolean;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface CollapsibleActions {
  setOpen: (open: boolean) => void;
  toggle: () => void;
  syncOpen: (open: boolean) => void;
}

export interface CollapsibleMachine {
  readonly state: CollapsibleState;
  readonly actions: CollapsibleActions;
  getState: () => CollapsibleState;
  subscribe: (callback: (state: CollapsibleState, meta?: ChangeMeta<boolean>) => void) => () => void;
}

export function createCollapsible(props: CollapsibleProps = {}): CollapsibleMachine {
  const initialOpen = props.open ?? props.defaultOpen ?? false;
  const disabled = props.disabled ?? false;
  const store = createStore<CollapsibleState, boolean>({
    open: initialOpen,
    disabled,
    lastError: null,
  });

  const emitOpen = (nextOpen: boolean, meta: ChangeMeta<boolean>) => {
    store.patchState(
      {
        open: nextOpen,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onOpenChange?.(nextOpen);
  };

  const actions: CollapsibleActions = {
    setOpen(open) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Collapsible',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      emitOpen(open, {
        source: 'programmatic',
        reason: 'set-open',
        previousValue: state.open,
        nextValue: open,
      });
    },
    toggle() {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Collapsible',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      const nextOpen = !state.open;
      emitOpen(nextOpen, {
        source: 'user',
        reason: 'toggle',
        previousValue: state.open,
        nextValue: nextOpen,
        inputModality: 'pointer',
      });
    },
    syncOpen(open) {
      const state = store.getState();
      emitOpen(open, {
        source: 'controlled-sync',
        reason: 'sync-open',
        previousValue: state.open,
        nextValue: open,
      });
    },
  };

  return {
    get state() {
      return store.getState();
    },
    actions,
    getState: store.getState,
    subscribe: store.subscribe,
  };
}

export type CollapsibleMachineEvent =
  | { type: 'TOGGLE' }
  | { type: 'OPEN' }
  | { type: 'CLOSE' };

export function createCollapsibleMachine(initialOpen = false, initialDisabled = false) {
  const machine = createCollapsible({
    defaultOpen: initialOpen,
    disabled: initialDisabled,
  });

  return {
    get state() {
      return machine.state.open ? 'open' : 'closed';
    },
    send(event: CollapsibleMachineEvent) {
      if (event.type === 'TOGGLE') {
        machine.actions.toggle();
      } else if (event.type === 'OPEN') {
        machine.actions.setOpen(true);
      } else {
        machine.actions.setOpen(false);
      }
    },
    subscribe: machine.subscribe,
  };
}
