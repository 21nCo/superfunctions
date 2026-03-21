import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import {
  computePosition,
  type Align,
  type ComputePositionOptions,
  type PositionResult,
  type RectLike,
  type Side,
} from '../utils/position';
import { type ChangeMeta, createStore } from './shared';

export interface MenuItem {
  id: string;
  disabled?: boolean;
  parentId?: string;
  group?: string;
}

export interface DropdownMenuProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  items?: MenuItem[];
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  collisionDetection?: boolean;
}

export interface DropdownMenuState {
  open: boolean;
  items: MenuItem[];
  highlightedItem: string | null;
  submenuPath: string[];
  lastSelectedItem: string | null;
  side: Side;
  align: Align;
  sideOffset: number;
  alignOffset: number;
  collisionPadding: number;
  collisionDetection: boolean;
  position: PositionResult | null;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface DropdownMenuActions {
  setOpen: (open: boolean) => void;
  registerItem: (item: MenuItem) => void;
  setItems: (items: MenuItem[]) => void;
  highlightItem: (itemId: string | null) => void;
  handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  selectItem: (itemId: string) => boolean;
  openSubmenu: (triggerId: string) => string | null;
  closeSubmenu: () => string | null;
  computePosition: (
    anchorRect: RectLike,
    contentRect: RectLike,
    viewport: { width: number; height: number; scrollX?: number; scrollY?: number }
  ) => PositionResult;
}

export interface DropdownMenuMachine {
  readonly state: DropdownMenuState;
  readonly actions: DropdownMenuActions;
  getState: () => DropdownMenuState;
  subscribe: (
    callback: (state: DropdownMenuState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

function normalizeItems(items: MenuItem[] | undefined): MenuItem[] {
  const dedupe = new Map<string, MenuItem>();
  (items ?? []).forEach((item) => {
    dedupe.set(item.id, item);
  });

  return Array.from(dedupe.values());
}

function getItemsForParent(items: MenuItem[], parentId?: string): MenuItem[] {
  return items.filter((item) => item.parentId === parentId);
}

function getEnabledItemIds(items: MenuItem[]): string[] {
  return items.filter((item) => !item.disabled).map((item) => item.id);
}

function hasSubmenu(items: MenuItem[], id: string): boolean {
  return items.some((item) => item.parentId === id);
}

function getCurrentMenuParent(submenuPath: string[]): string | undefined {
  return submenuPath.length > 0 ? submenuPath[submenuPath.length - 1] : undefined;
}

function getActiveItemIds(items: MenuItem[], submenuPath: string[]): string[] {
  const parent = getCurrentMenuParent(submenuPath);
  return getEnabledItemIds(getItemsForParent(items, parent));
}

function createNavigationError(details: Record<string, unknown>): UIFnError {
  return createUIFnError({
    code: 'UIFN_ERR_MENU_NAVIGATION',
    package: '@uifn/core',
    component: 'DropdownMenu',
    message: 'Nested menus MUST restore focus and close deterministically.',
    recoverable: true,
    details,
  });
}

export function createDropdownMenu(props: DropdownMenuProps): DropdownMenuMachine {
  const open = props.open ?? props.defaultOpen ?? false;
  const items = normalizeItems(props.items);
  const initialRootIds = getEnabledItemIds(getItemsForParent(items));
  const store = createStore<DropdownMenuState, boolean>({
    open,
    items,
    highlightedItem: open ? initialRootIds[0] ?? null : null,
    submenuPath: [],
    lastSelectedItem: null,
    side: props.side ?? 'bottom',
    align: props.align ?? 'center',
    sideOffset: props.sideOffset ?? 5,
    alignOffset: props.alignOffset ?? 0,
    collisionPadding: props.collisionPadding ?? 5,
    collisionDetection: props.collisionDetection ?? true,
    position: null,
    lastError: null,
  });

  const actions: DropdownMenuActions = {
    setOpen(nextOpen) {
      const state = store.getState();
      if (state.open === nextOpen) {
        return;
      }

      const rootIds = getEnabledItemIds(getItemsForParent(state.items));
      const meta: ChangeMeta<boolean> = {
        source: 'programmatic',
        reason: 'set-open',
        previousValue: state.open,
        nextValue: nextOpen,
      };

      store.patchState(
        {
          open: nextOpen,
          highlightedItem: nextOpen ? rootIds[0] ?? null : null,
          submenuPath: nextOpen ? [] : state.submenuPath,
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
      props.onOpenChange?.(nextOpen);
    },
    registerItem(item) {
      const state = store.getState();
      if (state.items.some((entry) => entry.id === item.id)) {
        return;
      }

      store.patchState({
        items: [...state.items, item],
      });
    },
    setItems(nextItems) {
      const state = store.getState();
      const normalized = normalizeItems(nextItems);
      const nextHighlighted = normalized.some((item) => item.id === state.highlightedItem)
        ? state.highlightedItem
        : getEnabledItemIds(getItemsForParent(normalized, getCurrentMenuParent(state.submenuPath)))[0] ??
          null;

      store.patchState({
        items: normalized,
        highlightedItem: nextHighlighted,
      });
    },
    highlightItem(itemId) {
      const state = store.getState();
      if (!itemId) {
        store.patchState({
          highlightedItem: null,
        });
        return;
      }

      if (!state.items.some((item) => item.id === itemId && !item.disabled)) {
        return;
      }

      store.patchState({
        highlightedItem: itemId,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      if (!state.open) {
        return null;
      }

      const activeIds = getActiveItemIds(state.items, state.submenuPath);
      if (activeIds.length === 0) {
        return null;
      }

      const activeItem = currentItem ?? state.highlightedItem;

      if (!activeItem) {
        if (key === 'ArrowDown' || key === 'Home') {
          const firstItem = activeIds[0] ?? null;
          store.patchState({
            highlightedItem: firstItem,
          });
          return firstItem;
        }

        if (key === 'ArrowUp' || key === 'End') {
          const lastItem = activeIds[activeIds.length - 1] ?? null;
          store.patchState({
            highlightedItem: lastItem,
          });
          return lastItem;
        }
      }

      if (key === 'ArrowRight') {
        if (!activeItem) {
          return null;
        }
        return actions.openSubmenu(activeItem);
      }

      if (key === 'ArrowLeft') {
        return actions.closeSubmenu();
      }

      if (key === 'Escape') {
        if (state.submenuPath.length > 0) {
          return actions.closeSubmenu();
        }

        const meta: ChangeMeta<boolean> = {
          source: 'user',
          reason: 'close-escape',
          previousValue: true,
          nextValue: false,
          inputModality: 'keyboard',
        };
        store.patchState(
          {
            open: false,
            lastChangeMeta: meta,
            lastError: null,
          },
          meta
        );
        props.onOpenChange?.(false);
        return state.highlightedItem;
      }

      const currentIndex = Math.max(0, activeIds.indexOf(activeItem ?? activeIds[0]));
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: activeIds.length,
        currentIndex,
        orientation: 'vertical',
      });

      if (nextIndex < 0 || nextIndex === currentIndex) {
        return activeIds[currentIndex] ?? null;
      }

      const nextItem = activeIds[nextIndex] ?? null;
      if (!nextItem) {
        return null;
      }

      store.patchState({
        highlightedItem: nextItem,
      });
      return nextItem;
    },
    selectItem(itemId) {
      const state = store.getState();
      const selectedItem = state.items.find((item) => item.id === itemId);
      if (!selectedItem) {
        store.patchState({
          lastError: createNavigationError({
            type: 'missing-item',
            itemId,
          }),
        });
        return false;
      }

      if (selectedItem.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'DropdownMenu',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
            details: {
              itemId,
            },
          }),
        });
        return false;
      }

      if (hasSubmenu(state.items, itemId)) {
        actions.openSubmenu(itemId);
        return false;
      }

      const meta: ChangeMeta<boolean> = {
        source: 'user',
        reason: 'select-item',
        previousValue: state.open,
        nextValue: false,
        inputModality: 'keyboard',
      };
      store.patchState(
        {
          open: false,
          highlightedItem: itemId,
          lastSelectedItem: itemId,
          submenuPath: [],
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
      props.onOpenChange?.(false);
      return true;
    },
    openSubmenu(triggerId) {
      const state = store.getState();
      if (!hasSubmenu(state.items, triggerId)) {
        store.patchState({
          lastError: createNavigationError({
            type: 'missing-submenu',
            triggerId,
          }),
        });
        return state.highlightedItem;
      }

      const nextPath = [...state.submenuPath, triggerId];
      const submenuIds = getActiveItemIds(state.items, nextPath);
      const nextHighlighted = submenuIds[0] ?? triggerId;

      store.patchState({
        submenuPath: nextPath,
        highlightedItem: nextHighlighted,
        lastError: null,
      });
      return nextHighlighted;
    },
    closeSubmenu() {
      const state = store.getState();
      if (state.submenuPath.length === 0) {
        store.patchState({
          lastError: createNavigationError({
            type: 'empty-submenu-stack',
          }),
        });
        return state.highlightedItem;
      }

      const nextPath = state.submenuPath.slice(0, -1);
      const restoredTrigger = state.submenuPath[state.submenuPath.length - 1] ?? null;

      store.patchState({
        submenuPath: nextPath,
        highlightedItem: restoredTrigger,
        lastError: null,
      });
      return restoredTrigger;
    },
    computePosition(anchorRect, contentRect, viewport) {
      const state = store.getState();
      const options: ComputePositionOptions = {
        side: state.side,
        align: state.align,
        sideOffset: state.sideOffset,
        alignOffset: state.alignOffset,
        collisionPadding: state.collisionPadding,
        collisionDetection: state.collisionDetection,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
      };
      const position = computePosition(anchorRect, contentRect, options);
      store.patchState({
        position,
        lastError: position.overflow
          ? createUIFnError({
              code: 'UIFN_ERR_POSITIONING_OVERFLOW',
              package: '@uifn/core',
              component: 'DropdownMenu',
              message: 'Popup families MUST resolve collisions deterministically.',
              recoverable: true,
              details: {
                overflowSides: position.overflowSides,
              },
            })
          : null,
      });

      return position;
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
