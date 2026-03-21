import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore } from './shared';

export interface MenuBarItem {
  id: string;
  disabled?: boolean;
}

export interface MenuBarState {
  value: string;
  items: MenuBarItem[];
  focusedItem: string | null;
  orientation: 'horizontal';
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface MenuBarActions {
  setValue: (value: string) => void;
  close: () => void;
  registerItem: (item: MenuBarItem) => void;
  setItems: (items: MenuBarItem[]) => void;
  focusItem: (itemId: string | null) => void;
  handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  handleEscape: () => string | null;
}

export interface MenuBarMachine {
  readonly state: MenuBarState;
  readonly actions: MenuBarActions;
  getState: () => MenuBarState;
  subscribe: (
    callback: (state: MenuBarState, meta?: ChangeMeta<string>) => void
  ) => () => void;
}

export interface CreateMenuBarProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  items?: MenuBarItem[];
}

function normalizeItems(items: MenuBarItem[] | undefined): MenuBarItem[] {
  const dedupe = new Map<string, MenuBarItem>();
  (items ?? []).forEach((item) => {
    dedupe.set(item.id, item);
  });

  return Array.from(dedupe.values());
}

function getEnabledItems(items: MenuBarItem[]): string[] {
  return items.filter((item) => !item.disabled).map((item) => item.id);
}

export function createMenuBar(props: CreateMenuBarProps = {}): MenuBarMachine {
  const items = normalizeItems(props.items);
  const enabledItems = getEnabledItems(items);
  const initialValue = props.value ?? props.defaultValue ?? '';
  const store = createStore<MenuBarState, string>({
    value: initialValue,
    items,
    focusedItem: enabledItems.includes(initialValue) ? initialValue : enabledItems[0] ?? null,
    orientation: 'horizontal',
    lastError: null,
  });

  const emitValue = (
    nextValue: string,
    reason: string,
    source: ChangeMeta<string>['source'],
    inputModality?: ChangeMeta<string>['inputModality']
  ) => {
    const state = store.getState();
    const meta: ChangeMeta<string> = {
      source,
      reason,
      previousValue: state.value,
      nextValue,
      inputModality,
    };
    store.patchState(
      {
        value: nextValue,
        focusedItem: nextValue || state.focusedItem,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onValueChange?.(nextValue);
  };

  const actions: MenuBarActions = {
    setValue(nextValue) {
      const state = store.getState();
      const enabled = getEnabledItems(state.items);
      if (nextValue !== '' && !enabled.includes(nextValue)) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_MENU_NAVIGATION',
            package: '@uifn/core',
            component: 'MenuBar',
            message: 'Menu items navigate correctly with arrow keys, Home/End, and escape semantics.',
            recoverable: true,
            details: {
              value: nextValue,
            },
          }),
        });
        return;
      }

      emitValue(nextValue, 'set-value', 'programmatic');
    },
    close() {
      emitValue('', 'close', 'programmatic');
    },
    registerItem(item) {
      const state = store.getState();
      if (state.items.some((entry) => entry.id === item.id)) {
        return;
      }

      const nextItems = [...state.items, item];
      const enabled = getEnabledItems(nextItems);
      store.patchState({
        items: nextItems,
        focusedItem: state.focusedItem ?? enabled[0] ?? null,
      });
    },
    setItems(nextItems) {
      const state = store.getState();
      const normalized = normalizeItems(nextItems);
      const enabled = getEnabledItems(normalized);
      store.patchState({
        items: normalized,
        focusedItem: enabled.includes(state.focusedItem ?? '') ? state.focusedItem : enabled[0] ?? null,
      });
    },
    focusItem(itemId) {
      const state = store.getState();
      if (itemId === null) {
        store.patchState({
          focusedItem: null,
        });
        return;
      }

      if (!getEnabledItems(state.items).includes(itemId)) {
        return;
      }

      store.patchState({
        focusedItem: itemId,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabled = getEnabledItems(state.items);
      if (enabled.length === 0) {
        return null;
      }

      const current = currentItem ?? state.focusedItem ?? enabled[0];
      const currentIndex = Math.max(0, enabled.indexOf(current));
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: enabled.length,
        currentIndex,
        orientation: 'horizontal',
      });

      if (nextIndex < 0) {
        return null;
      }

      const nextItem = enabled[nextIndex] ?? null;
      if (!nextItem) {
        return null;
      }

      store.patchState({
        focusedItem: nextItem,
      });

      if (state.value !== '') {
        emitValue(nextItem, 'keyboard-navigation', 'user', 'keyboard');
      }

      return nextItem;
    },
    handleEscape() {
      const state = store.getState();
      const focused = state.value || state.focusedItem;
      emitValue('', 'close-escape', 'user', 'keyboard');
      return focused;
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
