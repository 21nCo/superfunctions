import { createUIFnError, type UIFnError } from '../errors';
import {
  computePositionAtPoint,
  type ComputePositionOptions,
  type PositionResult,
  type RectLike,
} from '../utils/position';
import { type ChangeMeta, createStore } from './shared';
import {
  createDropdownMenu,
  type DropdownMenuActions,
  type DropdownMenuProps,
  type MenuItem,
} from './dropdown-menu';

export interface ContextMenuProps extends Omit<DropdownMenuProps, 'side' | 'align'> {
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  disabled: boolean;
  items: MenuItem[];
  highlightedItem: string | null;
  submenuPath: string[];
  lastSelectedItem: string | null;
  position: PositionResult | null;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface ContextMenuActions
  extends Pick<
    DropdownMenuActions,
    'registerItem' | 'setItems' | 'highlightItem' | 'handleKeyDown' | 'selectItem' | 'openSubmenu' | 'closeSubmenu'
  > {
  setOpen: (open: boolean, coords?: { x: number; y: number }) => void;
  openAt: (coords: { x: number; y: number }) => void;
  computePosition: (
    contentRect: RectLike,
    viewport: {
      width: number;
      height: number;
      collisionPadding?: number;
      scrollX?: number;
      scrollY?: number;
    }
  ) => PositionResult;
}

export interface ContextMenuMachine {
  readonly state: ContextMenuState;
  readonly actions: ContextMenuActions;
  getState: () => ContextMenuState;
  subscribe: (
    callback: (state: ContextMenuState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

export function createContextMenu(props: ContextMenuProps): ContextMenuMachine {
  const dropdown = createDropdownMenu({
    ...props,
    side: 'right',
    align: 'start',
  });
  const store = createStore<ContextMenuState, boolean>({
    open: dropdown.state.open,
    x: 0,
    y: 0,
    disabled: props.disabled ?? false,
    items: dropdown.state.items,
    highlightedItem: dropdown.state.highlightedItem,
    submenuPath: dropdown.state.submenuPath,
    lastSelectedItem: dropdown.state.lastSelectedItem,
    position: null,
    lastError: null,
  });

  dropdown.subscribe((dropdownState, meta) => {
    store.patchState(
      {
        open: dropdownState.open,
        items: dropdownState.items,
        highlightedItem: dropdownState.highlightedItem,
        submenuPath: dropdownState.submenuPath,
        lastSelectedItem: dropdownState.lastSelectedItem,
        lastChangeMeta: meta,
        lastError: dropdownState.lastError,
      },
      meta
    );
  });

  const actions: ContextMenuActions = {
    setOpen(nextOpen, coords) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'ContextMenu',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (coords) {
        store.patchState({
          x: coords.x,
          y: coords.y,
        });
      }

      dropdown.actions.setOpen(nextOpen);
      props.onOpenChange?.(nextOpen);
    },
    openAt(coords) {
      actions.setOpen(true, coords);
    },
    registerItem: dropdown.actions.registerItem,
    setItems: dropdown.actions.setItems,
    highlightItem: dropdown.actions.highlightItem,
    handleKeyDown: dropdown.actions.handleKeyDown,
    selectItem: dropdown.actions.selectItem,
    openSubmenu: dropdown.actions.openSubmenu,
    closeSubmenu: dropdown.actions.closeSubmenu,
    computePosition(contentRect, viewport) {
      const state = store.getState();
      const options: ComputePositionOptions = {
        side: 'right',
        align: 'start',
        sideOffset: 2,
        collisionPadding: viewport.collisionPadding ?? 5,
        collisionDetection: true,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
      };
      const position = computePositionAtPoint(
        { x: state.x, y: state.y },
        contentRect,
        options
      );

      store.patchState({
        position,
        lastError: position.overflow
          ? createUIFnError({
              code: 'UIFN_ERR_POSITIONING_OVERFLOW',
              package: '@uifn/core',
              component: 'ContextMenu',
              message: 'Popup families MUST resolve collisions deterministically.',
              recoverable: true,
              details: {
                overflowSides: position.overflowSides,
                invocationPoint: {
                  x: state.x,
                  y: state.y,
                },
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
