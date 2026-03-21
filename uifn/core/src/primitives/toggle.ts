import { createUIFnError, type UIFnError } from '../errors';
import { K } from '../aria/keys';
import { type ChangeMeta, createStore } from './shared';

export interface ToggleProps {
  pressed?: boolean;
  defaultPressed?: boolean;
  disabled?: boolean;
  onPressedChange?: (pressed: boolean) => void;
}

export interface ToggleState {
  pressed: boolean;
  disabled: boolean;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface ToggleActions {
  setPressed: (pressed: boolean) => void;
  toggle: () => void;
  handleKeyDown: (key: string) => void;
  syncPressed: (pressed: boolean) => void;
}

export interface ToggleMachine {
  readonly state: ToggleState;
  readonly actions: ToggleActions;
  getState: () => ToggleState;
  subscribe: (callback: (state: ToggleState, meta?: ChangeMeta<boolean>) => void) => () => void;
}

export function createToggle(props: ToggleProps): ToggleMachine {
  const initialPressed = props.pressed ?? props.defaultPressed ?? false;
  const disabled = props.disabled ?? false;
  const store = createStore<ToggleState, boolean>({
    pressed: initialPressed,
    disabled,
    lastError: null,
  });

  const emitPressed = (nextPressed: boolean, meta: ChangeMeta<boolean>) => {
    store.patchState(
      {
        pressed: nextPressed,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onPressedChange?.(nextPressed);
  };

  const ensureEnabled = (): boolean => {
    const state = store.getState();
    if (!state.disabled) {
      return true;
    }

    store.patchState({
      lastError: createUIFnError({
        code: 'UIFN_ERR_DISABLED_INTERACTION',
        package: '@uifn/core',
        component: 'Toggle',
        message: 'Disabled controls MUST ignore state-changing input.',
        recoverable: true,
      }),
    });
    return false;
  };

  const actions: ToggleActions = {
    setPressed(pressed) {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      emitPressed(pressed, {
        source: 'programmatic',
        reason: 'set-pressed',
        previousValue: state.pressed,
        nextValue: pressed,
      });
    },
    toggle() {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      const nextPressed = !state.pressed;
      emitPressed(nextPressed, {
        source: 'user',
        reason: 'toggle',
        previousValue: state.pressed,
        nextValue: nextPressed,
        inputModality: 'pointer',
      });
    },
    handleKeyDown(key) {
      if (key !== K.SPACE) {
        return;
      }
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      const nextPressed = !state.pressed;
      emitPressed(nextPressed, {
        source: 'user',
        reason: 'keyboard-toggle',
        previousValue: state.pressed,
        nextValue: nextPressed,
        inputModality: 'keyboard',
      });
    },
    syncPressed(pressed) {
      const state = store.getState();
      emitPressed(pressed, {
        source: 'controlled-sync',
        reason: 'sync-pressed',
        previousValue: state.pressed,
        nextValue: pressed,
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
