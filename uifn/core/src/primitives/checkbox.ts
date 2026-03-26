import { createUIFnError, type UIFnError } from '../errors';
import { K } from '../aria/keys';
import { createControllableStateController } from '../state/machine';
import { type ChangeMeta, createStore } from './shared';

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  onCheckedChange?: (checked: CheckedState) => void;
}

export interface CheckboxState {
  checked: CheckedState;
  controlled: boolean;
  disabled: boolean;
  required: boolean;
  name?: string;
  value: string;
  ariaChecked: 'true' | 'false' | 'mixed';
  formValue: Record<string, string>;
  lastChangeMeta?: ChangeMeta<CheckedState>;
  lastError: UIFnError | null;
}

export interface CheckboxActions {
  setChecked: (checked: CheckedState) => void;
  toggle: () => void;
  handleKeyDown: (key: string) => void;
  syncChecked: (checked: CheckedState) => void;
  getFormValue: () => Record<string, string>;
}

export interface CheckboxMachine {
  readonly state: CheckboxState;
  readonly actions: CheckboxActions;
  getState: () => CheckboxState;
  subscribe: (callback: (state: CheckboxState, meta?: ChangeMeta<CheckedState>) => void) => () => void;
}

function getAriaChecked(checked: CheckedState): 'true' | 'false' | 'mixed' {
  if (checked === 'indeterminate') {
    return 'mixed';
  }
  return checked ? 'true' : 'false';
}

function getFormValue(name: string | undefined, value: string, checked: CheckedState): Record<string, string> {
  if (!name || checked !== true) {
    return {};
  }

  return {
    [name]: value,
  };
}

export function createCheckbox(props: CheckboxProps): CheckboxMachine {
  const initialChecked = props.checked ?? props.defaultChecked ?? false;
  const disabled = props.disabled ?? false;
  const required = props.required ?? false;
  const value = props.value ?? 'on';
  const name = props.name;
  const controlledState = createControllableStateController<CheckedState>({
    value: props.checked,
    defaultValue: props.defaultChecked ?? false,
    onChange: props.onCheckedChange,
  });

  const store = createStore<CheckboxState, CheckedState>({
    checked: controlledState.getValue(),
    controlled: controlledState.isControlled(),
    disabled,
    required,
    name,
    value,
    ariaChecked: getAriaChecked(controlledState.getValue()),
    formValue: getFormValue(name, value, controlledState.getValue()),
    lastError: null,
  });

  const emitChecked = (nextChecked: CheckedState, meta: ChangeMeta<CheckedState>) => {
    const result =
      meta.source === 'controlled-sync'
        ? controlledState.syncValue(nextChecked)
        : controlledState.requestValue(nextChecked);
    store.patchState(
      {
        checked: result.value,
        ariaChecked: getAriaChecked(result.value),
        formValue: getFormValue(name, value, result.value),
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
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
        component: 'Checkbox',
        message: 'Disabled controls MUST ignore state-changing input.',
        recoverable: true,
      }),
    });
    return false;
  };

  const actions: CheckboxActions = {
    setChecked(checked) {
      if (!ensureEnabled()) {
        return;
      }
      const state = store.getState();
      if (state.checked === checked) {
        return;
      }
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
      const nextChecked = state.checked === 'indeterminate' ? true : !state.checked;
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
      const nextChecked = state.checked === 'indeterminate' ? true : !state.checked;
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
      if (state.checked === checked) {
        return;
      }

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
