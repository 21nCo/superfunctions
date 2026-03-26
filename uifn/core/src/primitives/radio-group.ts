import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { getNextEnabledRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore, uniqueStrings } from './shared';

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  required?: boolean;
  orientation?: 'horizontal' | 'vertical';
  name?: string;
  items?: string[];
  onValueChange?: (value: string) => void;
}

export interface RadioGroupState {
  value: string;
  controlled: boolean;
  disabled: boolean;
  required: boolean;
  orientation: 'horizontal' | 'vertical';
  name?: string;
  items: string[];
  disabledItems: string[];
  focusedItem: string | null;
  formValue: Record<string, string>;
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface RadioGroupActions {
  setValue: (value: string) => void;
  registerItem: (value: string, disabled?: boolean) => void;
  unregisterItem: (value: string) => void;
  setItemDisabled: (value: string, disabled: boolean) => void;
  handleKeyDown: (key: string, currentItem: string) => string | null;
  syncValue: (value: string) => void;
  getFormValue: () => Record<string, string>;
}

export interface RadioGroupMachine {
  readonly state: RadioGroupState;
  readonly actions: RadioGroupActions;
  getState: () => RadioGroupState;
  subscribe: (callback: (state: RadioGroupState, meta?: ChangeMeta<string>) => void) => () => void;
}

function getFormValue(name: string | undefined, value: string): Record<string, string> {
  if (!name || !value) {
    return {};
  }

  return {
    [name]: value,
  };
}

function validateRadioValue(value: string, items: string[]): void {
  if (!value || items.length === 0) {
    return;
  }

  if (!items.includes(value)) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'RadioGroup',
      message: 'Invalid external values MUST be handled deterministically.',
      details: {
        value,
        items,
      },
    });
  }
}

export function createRadioGroup(props: RadioGroupProps): RadioGroupMachine {
  const initialValue = props.value ?? props.defaultValue ?? '';
  const orientation = props.orientation ?? 'vertical';
  const items = uniqueStrings(props.items ?? []);
  const controlledState = createControllableStateController({
    value: props.value,
    defaultValue: props.defaultValue ?? '',
    onChange: props.onValueChange,
  });

  validateRadioValue(initialValue, items);

  const store = createStore<RadioGroupState, string>({
    value: controlledState.getValue(),
    controlled: controlledState.isControlled(),
    disabled: props.disabled ?? false,
    required: props.required ?? false,
    orientation,
    name: props.name,
    items,
    disabledItems: [],
    focusedItem: initialValue || items[0] || null,
    formValue: getFormValue(props.name, controlledState.getValue()),
    lastError: null,
  });

  const emitValue = (nextValue: string, meta: ChangeMeta<string>) => {
    const state = store.getState();
    validateRadioValue(nextValue, state.items);
    const result =
      meta.source === 'controlled-sync'
        ? controlledState.syncValue(nextValue)
        : controlledState.requestValue(nextValue);
    store.patchState(
      {
        value: result.value,
        focusedItem: nextValue || state.focusedItem,
        formValue: getFormValue(state.name, result.value),
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
  };

  const ensureEnabled = (value?: string): boolean => {
    const state = store.getState();
    if (!state.disabled && (!value || !state.disabledItems.includes(value))) {
      return true;
    }

    store.patchState({
      lastError: createUIFnError({
        code: 'UIFN_ERR_DISABLED_INTERACTION',
        package: '@uifn/core',
        component: 'RadioGroup',
        message: 'Disabled controls MUST ignore state-changing input.',
        recoverable: true,
      }),
    });
    return false;
  };

  const actions: RadioGroupActions = {
    setValue(value) {
      if (!ensureEnabled(value)) {
        return;
      }

      const state = store.getState();
      if (state.value === value) {
        return;
      }
      emitValue(value, {
        source: 'programmatic',
        reason: 'set-value',
        previousValue: state.value,
        nextValue: value,
      });
    },
    registerItem(value, disabled = false) {
      const state = store.getState();
      if (state.items.includes(value)) {
        if (disabled !== state.disabledItems.includes(value)) {
          actions.setItemDisabled(value, disabled);
        }
        return;
      }

      const nextItems = [...state.items, value];
      validateRadioValue(state.value, nextItems);
      store.patchState({
        items: nextItems,
        disabledItems: disabled
          ? uniqueStrings([...state.disabledItems, value])
          : state.disabledItems,
        focusedItem: state.focusedItem ?? value,
      });
    },
    unregisterItem(value) {
      const state = store.getState();
      const nextItems = state.items.filter((entry) => entry !== value);
      const nextDisabledItems = state.disabledItems.filter((entry) => entry !== value);
      const nextValue = state.value === value ? '' : state.value;
      if (nextValue !== state.value) {
        controlledState.syncValue(nextValue);
      }
      store.patchState({
        items: nextItems,
        disabledItems: nextDisabledItems,
        value: nextValue,
        focusedItem:
          state.focusedItem === value ? nextItems[0] ?? null : state.focusedItem,
        formValue: getFormValue(state.name, nextValue),
      });
    },
    setItemDisabled(value, disabled) {
      const state = store.getState();
      if (!state.items.includes(value)) {
        return;
      }

      const nextDisabledItems = disabled
        ? uniqueStrings([...state.disabledItems, value])
        : state.disabledItems.filter((entry) => entry !== value);
      const nextValue = disabled && state.value === value ? '' : state.value;
      if (nextValue !== state.value) {
        controlledState.syncValue(nextValue);
      }
      store.patchState({
        disabledItems: nextDisabledItems,
        value: nextValue,
        formValue: getFormValue(state.name, nextValue),
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabledItems = state.items.filter(
        (item) => !state.disabledItems.includes(item)
      );
      if (enabledItems.length === 0) {
        return null;
      }

      const currentIndex = Math.max(0, enabledItems.indexOf(currentItem));
      const nextIndex = getNextEnabledRovingFocusIndex({
        key,
        itemCount: enabledItems.length,
        currentIndex,
        orientation: state.orientation,
      });

      if (nextIndex < 0 || nextIndex === currentIndex) {
        return null;
      }

      const nextItem = enabledItems[nextIndex] ?? null;
      if (!nextItem) {
        return null;
      }

      emitValue(nextItem, {
        source: 'user',
        reason: 'keyboard-navigation',
        previousValue: state.value,
        nextValue: nextItem,
        inputModality: 'keyboard',
      });
      return nextItem;
    },
    syncValue(value) {
      const state = store.getState();
      if (state.value === value) {
        return;
      }

      emitValue(value, {
        source: 'controlled-sync',
        reason: 'sync-value',
        previousValue: state.value,
        nextValue: value,
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
