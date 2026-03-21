import { createUIFnError, type UIFnError } from '../errors';
import { K } from '../aria/keys';
import { type ChangeMeta, createStore } from './shared';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  onCheckedChange?: (checked: boolean) => void;
}

export interface SwitchState {
  checked: boolean;
  disabled: boolean;
  required: boolean;
  name?: string;
  value: string;
  formValue: Record<string, string>;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface SwitchActions {
  setChecked: (checked: boolean) => void;
  toggle: () => void;
  handleKeyDown: (key: string) => void;
  syncChecked: (checked: boolean) => void;
  getFormValue: () => Record<string, string>;
}

export interface SwitchMachine {
  readonly state: SwitchState;
  readonly actions: SwitchActions;
  getState: () => SwitchState;
  subscribe: (callback: (state: SwitchState, meta?: ChangeMeta<boolean>) => void) => () => void;
}

function getFormValue(name: string | undefined, value: string, checked: boolean): Record<string, string> {
  if (!name || !checked) {
    return {};
  }

  return {
    [name]: value,
  };
}

export function createSwitch(props: SwitchProps): SwitchMachine {
  const initialChecked = props.checked ?? props.defaultChecked ?? false;
  const disabled = props.disabled ?? false;
  const required = props.required ?? false;
  const value = props.value ?? 'on';
  const name = props.name;

  const store = createStore<SwitchState, boolean>({
    checked: initialChecked,
    disabled,
    required,
    name,
    value,
    formValue: getFormValue(name, value, initialChecked),
    lastError: null,
  });

  const emitChecked = (nextChecked: boolean, meta: ChangeMeta<boolean>) => {
    store.patchState(
      {
        checked: nextChecked,
        formValue: getFormValue(name, value, nextChecked),
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onCheckedChange?.(nextChecked);
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
        component: 'Switch',
        message: 'Disabled controls MUST ignore state-changing input.',
        recoverable: true,
      }),
    });
    return false;
  };

  const actions: SwitchActions = {
    setChecked(checked) {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      emitChecked(checked, {
        source: 'programmatic',
        reason: 'set-checked',
        previousValue: state.checked,
        nextValue: checked,
      });
    },
    toggle() {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      const nextChecked = !state.checked;
      emitChecked(nextChecked, {
        source: 'user',
        reason: 'toggle',
        previousValue: state.checked,
        nextValue: nextChecked,
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
      const nextChecked = !state.checked;
      emitChecked(nextChecked, {
        source: 'user',
        reason: 'keyboard-toggle',
        previousValue: state.checked,
        nextValue: nextChecked,
        inputModality: 'keyboard',
      });
    },
    syncChecked(checked) {
      const state = store.getState();
      emitChecked(checked, {
        source: 'controlled-sync',
        reason: 'sync-checked',
        previousValue: state.checked,
        nextValue: checked,
      });
    },
    getFormValue() {
      return store.getState().formValue;
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
