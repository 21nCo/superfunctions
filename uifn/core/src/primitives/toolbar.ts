import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { createStore } from './shared';

export interface ToolbarItem {
  id: string;
  group?: string;
  disabled?: boolean;
}

export interface ToolbarProps {
  orientation?: 'horizontal' | 'vertical';
  items?: ToolbarItem[];
}

export interface ToolbarState {
  orientation: 'horizontal' | 'vertical';
  items: ToolbarItem[];
  focusedItem: string | null;
  groups: Record<string, string[]>;
  lastError: UIFnError | null;
}

export interface ToolbarActions {
  registerItem: (item: ToolbarItem) => void;
  setItems: (items: ToolbarItem[]) => void;
  focusItem: (itemId: string | null) => void;
  handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  getGroupItems: (group: string) => string[];
}

export interface ToolbarMachine {
  readonly state: ToolbarState;
  readonly actions: ToolbarActions;
  getState: () => ToolbarState;
  subscribe: (callback: (state: ToolbarState) => void) => () => void;
}

function normalizeItems(items: ToolbarItem[] | undefined): ToolbarItem[] {
  const dedupe = new Map<string, ToolbarItem>();
  (items ?? []).forEach((item) => {
    dedupe.set(item.id, item);
  });

  return Array.from(dedupe.values());
}

function resolveGroups(items: ToolbarItem[]): Record<string, string[]> {
  return items.reduce<Record<string, string[]>>((acc, item) => {
    if (!item.group) {
      return acc;
    }

    const existing = acc[item.group] ?? [];
    acc[item.group] = [...existing, item.id];
    return acc;
  }, {});
}

function getEnabledItemIds(items: ToolbarItem[]): string[] {
  return items.filter((item) => !item.disabled).map((item) => item.id);
}

export function createToolbar(props: ToolbarProps): ToolbarMachine {
  const items = normalizeItems(props.items);
  const enabledItems = getEnabledItemIds(items);
  const store = createStore<ToolbarState>({
    orientation: props.orientation ?? 'horizontal',
    items,
    focusedItem: enabledItems[0] ?? null,
    groups: resolveGroups(items),
    lastError: null,
  });

  const actions: ToolbarActions = {
    registerItem(item) {
      const state = store.getState();
      if (state.items.some((entry) => entry.id === item.id)) {
        return;
      }

      const nextItems = [...state.items, item];
      const nextEnabled = getEnabledItemIds(nextItems);
      store.patchState({
        items: nextItems,
        groups: resolveGroups(nextItems),
        focusedItem: state.focusedItem ?? nextEnabled[0] ?? null,
      });
    },
    setItems(nextItems) {
      const normalized = normalizeItems(nextItems);
      const nextEnabled = getEnabledItemIds(normalized);
      const state = store.getState();
      store.patchState({
        items: normalized,
        groups: resolveGroups(normalized),
        focusedItem: nextEnabled.includes(state.focusedItem ?? '')
          ? state.focusedItem
          : nextEnabled[0] ?? null,
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

      if (!getEnabledItemIds(state.items).includes(itemId)) {
        return;
      }

      store.patchState({
        focusedItem: itemId,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabled = getEnabledItemIds(state.items);
      if (enabled.length === 0) {
        return null;
      }

      const current = currentItem ?? state.focusedItem ?? enabled[0];
      const currentIndex = Math.max(0, enabled.indexOf(current));
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: enabled.length,
        currentIndex,
        orientation: state.orientation,
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
      return nextItem;
    },
    getGroupItems(group) {
      const state = store.getState();
      const groupItems = state.groups[group];
      if (!groupItems) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_INVALID_VALUE',
            package: '@uifn/core',
            component: 'Toolbar',
            message: 'Toolbar orientation and grouping semantics are documented and tested.',
            recoverable: true,
            details: {
              group,
            },
          }),
        });
        return [];
      }

      return groupItems;
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
