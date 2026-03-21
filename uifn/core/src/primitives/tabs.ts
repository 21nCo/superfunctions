import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore, uniqueStrings } from './shared';

export interface TabsProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
  disabled?: boolean;
  items?: string[];
}

export interface TabsState {
  value: string;
  orientation: 'horizontal' | 'vertical';
  activationMode: 'automatic' | 'manual';
  disabled: boolean;
  items: string[];
  focusedItem: string | null;
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface TabsActions {
  setValue: (value: string) => void;
  registerItem: (value: string) => void;
  unregisterItem: (value: string) => void;
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

function validateTabsValue(value: string, items: string[]): void {
  if (!value || items.length === 0) {
    return;
  }

  if (!items.includes(value)) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'Tabs',
      message: 'Invalid external values MUST be handled deterministically.',
      details: {
        value,
        items,
      },
    });
  }
}

export function createTabs(props: TabsProps): TabsMachine {
  const orientation = props.orientation ?? 'horizontal';
  const activationMode = props.activationMode ?? 'automatic';
  const disabled = props.disabled ?? false;
  const items = uniqueStrings(props.items ?? []);
  const initialValue = props.value ?? props.defaultValue ?? '';

  validateTabsValue(initialValue, items);

  const store = createStore<TabsState, string>({
    value: initialValue,
    orientation,
    activationMode,
    disabled,
    items,
    focusedItem: initialValue || items[0] || null,
    lastError: null,
  });

  const emitValue = (nextValue: string, meta: ChangeMeta<string>) => {
    validateTabsValue(nextValue, store.getState().items);
    store.patchState(
      {
        value: nextValue,
        focusedItem: nextValue || store.getState().focusedItem,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onValueChange?.(nextValue);
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

      emitValue(nextValue, {
        source: 'programmatic',
        reason: 'set-value',
        previousValue: state.value,
        nextValue,
      });
    },
    registerItem(value) {
      const state = store.getState();
      if (state.items.includes(value)) {
        return;
      }

      const nextItems = [...state.items, value];
      validateTabsValue(state.value, nextItems);
      store.patchState({
        items: nextItems,
        focusedItem: state.focusedItem ?? value,
        lastError: null,
      });
    },
    unregisterItem(value) {
      const state = store.getState();
      const nextItems = state.items.filter((entry) => entry !== value);
      const nextValue = state.value === value ? nextItems[0] ?? '' : state.value;
      store.patchState({
        items: nextItems,
        value: nextValue,
        focusedItem:
          state.focusedItem === value ? nextItems[0] ?? null : state.focusedItem,
      });
    },
    focusItem(value) {
      const state = store.getState();
      if (!state.items.includes(value)) {
        return;
      }

      store.patchState({
        focusedItem: value,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      if (state.items.length === 0) {
        return null;
      }

      const currentIndex = Math.max(0, state.items.indexOf(currentItem));
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: state.items.length,
        currentIndex,
        orientation: state.orientation,
      });

      if (nextIndex < 0) {
        return null;
      }

      const nextItem = state.items[nextIndex] ?? null;
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
      }

      return nextItem;
    },
    syncValue(value) {
      const state = store.getState();
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
