import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { getNextEnabledRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore, uniqueStrings } from './shared';

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
  disabled?: boolean;
  items?: string[];
  disabledItems?: string[];
}

export interface TabsState {
  value: string;
  orientation: 'horizontal' | 'vertical';
  activationMode: 'automatic' | 'manual';
  controlled: boolean;
  disabled: boolean;
  items: string[];
  disabledItems: string[];
  focusedItem: string | null;
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface TabsActions {
  setValue: (value: string) => void;
  registerItem: (value: string, disabled?: boolean) => void;
  unregisterItem: (value: string) => void;
  setItemDisabled: (value: string, disabled: boolean) => void;
  focusItem: (value: string) => void;
  handleKeyDown: (key: string, currentItem: string) => string | null;
  syncValue: (value: string) => void;
}

export interface TabsMachine {
  readonly state: TabsState;
  readonly actions: TabsActions;
  setValue: (value: string) => void;
  getState: () => TabsState;
  subscribe: (callback: (state: TabsState, meta?: ChangeMeta<string>) => void) => () => void;
}

function getEnabledTabsItems(items: string[], disabledItems: string[]): string[] {
  return items.filter((item) => !disabledItems.includes(item));
}

function validateTabsValue(
  value: string,
  items: string[],
  disabledItems: string[]
): void {
  if (!value || items.length === 0) {
    return;
  }

  if (!items.includes(value) || disabledItems.includes(value)) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'Tabs',
      message: 'Invalid external values MUST be handled deterministically.',
      details: {
        value,
        items,
        disabledItems,
      },
    });
  }
}

export function createTabs(props: TabsProps): TabsMachine {
  const orientation = props.orientation ?? 'horizontal';
  const activationMode = props.activationMode ?? 'automatic';
  const disabled = props.disabled ?? false;
  const items = uniqueStrings(props.items ?? []);
  const disabledItems = uniqueStrings(props.disabledItems ?? []).filter((item) =>
    items.includes(item)
  );
  const initialValue = props.value ?? props.defaultValue ?? '';
  const controlledState = createControllableStateController({
    value: props.value,
    defaultValue: props.defaultValue ?? '',
    onChange: props.onValueChange,
  });
  const initialFocusedItem =
    initialValue || getEnabledTabsItems(items, disabledItems)[0] || items[0] || null;

  validateTabsValue(initialValue, items, disabledItems);

  const store = createStore<TabsState, string>({
    value: controlledState.getValue(),
    orientation,
    activationMode,
    controlled: controlledState.isControlled(),
    disabled,
    items,
    disabledItems,
    focusedItem: initialFocusedItem,
    lastError: null,
  });

  const emitValue = (
    nextValue: string,
    meta: ChangeMeta<string>,
    options: { preserveValue?: boolean; focusedItem?: string | null } = {}
  ) => {
    const state = store.getState();
    validateTabsValue(nextValue, state.items, state.disabledItems);
    const result = options.preserveValue
      ? {
          value: state.value,
          changed: false,
          controlled: controlledState.isControlled(),
        }
      : meta.source === 'controlled-sync'
        ? controlledState.syncValue(nextValue)
        : controlledState.requestValue(nextValue);
    store.patchState(
      {
        value: result.value,
        focusedItem:
          options.focusedItem === undefined
            ? nextValue || state.focusedItem
            : options.focusedItem,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
  };

  const actions: TabsActions = {
    setValue(nextValue) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Tabs',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.disabledItems.includes(nextValue)) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Tabs',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.value === nextValue) {
        return;
      }

      emitValue(nextValue, {
        source: 'programmatic',
        reason: 'set-value',
        previousValue: state.value,
        nextValue,
      });
    },
    registerItem(value, itemDisabled = false) {
      const state = store.getState();
      if (state.items.includes(value)) {
        if (itemDisabled !== state.disabledItems.includes(value)) {
          actions.setItemDisabled(value, itemDisabled);
        }
        return;
      }

      const nextItems = [...state.items, value];
      const nextDisabledItems = itemDisabled
        ? uniqueStrings([...state.disabledItems, value])
        : state.disabledItems;
      validateTabsValue(state.value, nextItems, nextDisabledItems);
      store.patchState({
        items: nextItems,
        disabledItems: nextDisabledItems,
        focusedItem: state.focusedItem ?? (itemDisabled ? null : value),
        lastError: null,
      });
    },
    unregisterItem(value) {
      const state = store.getState();
      const nextItems = state.items.filter((entry) => entry !== value);
      const nextDisabledItems = state.disabledItems.filter((entry) => entry !== value);
      const enabledItems = getEnabledTabsItems(nextItems, nextDisabledItems);
      const nextValue = state.value === value ? enabledItems[0] ?? nextItems[0] ?? '' : state.value;
      if (nextValue !== state.value) {
        controlledState.syncValue(nextValue);
      }
      store.patchState({
        items: nextItems,
        disabledItems: nextDisabledItems,
        value: nextValue,
        focusedItem:
          state.focusedItem === value ? enabledItems[0] ?? nextItems[0] ?? null : state.focusedItem,
      });
    },
    setItemDisabled(value, itemDisabled) {
      const state = store.getState();
      if (!state.items.includes(value)) {
        return;
      }

      const nextDisabledItems = itemDisabled
        ? uniqueStrings([...state.disabledItems, value])
        : state.disabledItems.filter((entry) => entry !== value);
      const enabledItems = getEnabledTabsItems(state.items, nextDisabledItems);
      const nextValue = itemDisabled && state.value === value ? '' : state.value;
      const nextFocusedItem =
        itemDisabled && state.focusedItem === value
          ? enabledItems[0] ?? state.items[0] ?? null
          : state.focusedItem;
      if (nextValue !== state.value) {
        controlledState.syncValue(nextValue);
      }
      store.patchState({
        disabledItems: nextDisabledItems,
        value: nextValue,
        focusedItem: nextFocusedItem,
      });
    },
    focusItem(value) {
      const state = store.getState();
      if (!state.items.includes(value) || state.disabledItems.includes(value)) {
        return;
      }

      store.patchState({
        focusedItem: value,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabledItems = getEnabledTabsItems(state.items, state.disabledItems);
      if (enabledItems.length === 0) {
        return null;
      }

      const current =
        enabledItems.includes(currentItem)
          ? currentItem
          : enabledItems.includes(state.focusedItem ?? '')
            ? (state.focusedItem as string)
            : enabledItems[0];
      const currentIndex = Math.max(0, enabledItems.indexOf(current));
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

      if (state.activationMode === 'automatic') {
        emitValue(nextItem, {
          source: 'user',
          reason: 'keyboard-navigation',
          previousValue: state.value,
          nextValue: nextItem,
          inputModality: 'keyboard',
        });
      } else {
        emitValue(state.value, {
            source: 'user',
            reason: 'keyboard-navigation',
            previousValue: state.value,
            nextValue: state.value,
            inputModality: 'keyboard',
          },
          {
            preserveValue: true,
            focusedItem: nextItem,
          });
      }

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
  };

  return {
    get state() {
      return store.getState();
    },
    actions,
    setValue: actions.setValue,
    getState: store.getState,
    subscribe: store.subscribe,
  };
}
