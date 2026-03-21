import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore, uniqueStrings } from './shared';

export type ToggleGroupType = 'single' | 'multiple';

export interface ToggleGroupProps {
  type?: ToggleGroupType;
  value?: string | string[];
  defaultValue?: string | string[];
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  loop?: boolean;
  onValueChange?: (value: string | string[]) => void;
}

export interface ToggleGroupState {
  value: string | string[];
  type: ToggleGroupType;
  disabled: boolean;
  orientation: 'horizontal' | 'vertical';
  items: string[];
  disabledItems: string[];
  focusedItem: string | null;
  lastChangeMeta?: ChangeMeta<string | string[]>;
  lastError: UIFnError | null;
}

export interface ToggleGroupActions {
  setValue: (value: string | string[]) => void;
  toggleItem: (value: string) => void;
  registerItem: (value: string, disabled?: boolean) => void;
  unregisterItem: (value: string) => void;
  setItemDisabled: (value: string, disabled: boolean) => void;
  handleKeyDown: (key: string, currentItem: string) => string | null;
  syncValue: (value: string | string[]) => void;
}

export interface ToggleGroupMachine {
  readonly state: ToggleGroupState;
  readonly actions: ToggleGroupActions;
  getState: () => ToggleGroupState;
  subscribe: (
    callback: (state: ToggleGroupState, meta?: ChangeMeta<string | string[]>) => void
  ) => () => void;
}

function normalizeToggleGroupValue(
  value: string | string[] | undefined,
  type: ToggleGroupType
): string | string[] {
  if (type === 'single') {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }
    return value ?? '';
  }

  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  return value ? [value] : [];
}

function validateToggleGroupValue(
  value: string | string[],
  items: string[],
  type: ToggleGroupType
): void {
  if (items.length === 0) {
    return;
  }

  const invalidValues =
    type === 'single'
      ? typeof value === 'string' && value !== '' && !items.includes(value)
        ? [value]
        : []
      : (value as string[]).filter((entry) => !items.includes(entry));

  if (invalidValues.length > 0) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'ToggleGroup',
      message: 'Invalid external values MUST be handled deterministically.',
      details: {
        invalidValues,
        items,
      },
    });
  }
}

export function createToggleGroup(props: ToggleGroupProps): ToggleGroupMachine {
  const type = props.type ?? 'single';
  const orientation = props.orientation ?? 'horizontal';
  const loop = props.loop ?? true;
  const initialValue = normalizeToggleGroupValue(
    props.value ?? props.defaultValue,
    type
  );

  const store = createStore<ToggleGroupState, string | string[]>({
    value: initialValue,
    type,
    disabled: props.disabled ?? false,
    orientation,
    items: [],
    disabledItems: [],
    focusedItem: null,
    lastError: null,
  });

  const emitValue = (
    nextValue: string | string[],
    meta: ChangeMeta<string | string[]>
  ) => {
    const state = store.getState();
    validateToggleGroupValue(nextValue, state.items, type);
    store.patchState(
      {
        value: nextValue,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onValueChange?.(nextValue);
  };

  const actions: ToggleGroupActions = {
    setValue(nextValue) {
      const state = store.getState();
      const normalized = normalizeToggleGroupValue(nextValue, type);
      emitValue(normalized, {
        source: 'programmatic',
        reason: 'set-value',
        previousValue: state.value,
        nextValue: normalized,
      });
    },
    toggleItem(itemValue) {
      const state = store.getState();
      if (state.disabled || state.disabledItems.includes(itemValue)) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'ToggleGroup',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (type === 'single') {
        const currentValue = state.value as string;
        const nextValue = currentValue === itemValue ? '' : itemValue;
        emitValue(nextValue, {
          source: 'user',
          reason: 'toggle-item',
          previousValue: currentValue,
          nextValue,
          inputModality: 'pointer',
        });
        return;
      }

      const currentValues = state.value as string[];
      const nextValue = currentValues.includes(itemValue)
        ? currentValues.filter((value) => value !== itemValue)
        : [...currentValues, itemValue];

      emitValue(nextValue, {
        source: 'user',
        reason: 'toggle-item',
        previousValue: currentValues,
        nextValue,
        inputModality: 'pointer',
      });
    },
    registerItem(value, isDisabled = false) {
      const state = store.getState();
      if (state.items.includes(value)) {
        if (isDisabled !== state.disabledItems.includes(value)) {
          actions.setItemDisabled(value, isDisabled);
        }
        return;
      }

      const nextItems = [...state.items, value];
      const nextDisabledItems = isDisabled
        ? uniqueStrings([...state.disabledItems, value])
        : state.disabledItems;

      validateToggleGroupValue(state.value, nextItems, type);
      store.patchState({
        items: nextItems,
        disabledItems: nextDisabledItems,
        focusedItem: state.focusedItem ?? value,
      });
    },
    unregisterItem(value) {
      const state = store.getState();
      const nextItems = state.items.filter((entry) => entry !== value);
      const nextDisabledItems = state.disabledItems.filter((entry) => entry !== value);
      let nextValue = state.value;

      if (type === 'single') {
        nextValue = state.value === value ? '' : state.value;
      } else {
        nextValue = (state.value as string[]).filter((entry) => entry !== value);
      }

      store.patchState({
        items: nextItems,
        disabledItems: nextDisabledItems,
        value: nextValue,
        focusedItem:
          state.focusedItem === value ? nextItems[0] ?? null : state.focusedItem,
      });
    },
    setItemDisabled(value, isDisabled) {
      const state = store.getState();
      if (!state.items.includes(value)) {
        return;
      }

      const nextDisabledItems = isDisabled
        ? uniqueStrings([...state.disabledItems, value])
        : state.disabledItems.filter((entry) => entry !== value);

      let nextValue = state.value;
      if (type === 'single' && state.value === value && isDisabled) {
        nextValue = '';
      } else if (type === 'multiple' && isDisabled) {
        nextValue = (state.value as string[]).filter((entry) => entry !== value);
      }

      store.patchState({
        disabledItems: nextDisabledItems,
        value: nextValue,
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
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: enabledItems.length,
        currentIndex,
        orientation: state.orientation,
        loop,
      });

      if (nextIndex < 0) {
        return null;
      }

      const nextItem = enabledItems[nextIndex] ?? null;
      if (!nextItem) {
        return null;
      }

      store.patchState({
        focusedItem: nextItem,
        lastChangeMeta: {
          source: 'user',
          reason: 'keyboard-navigation',
          previousValue: state.value,
          nextValue: state.value,
          inputModality: 'keyboard',
        },
      });
      return nextItem;
    },
    syncValue(value) {
      const state = store.getState();
      const normalized = normalizeToggleGroupValue(value, type);
      emitValue(normalized, {
        source: 'controlled-sync',
        reason: 'sync-value',
        previousValue: state.value,
        nextValue: normalized,
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
