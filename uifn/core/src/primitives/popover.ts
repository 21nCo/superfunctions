import { createUIFnError, type UIFnError } from '../errors';
import { createFocusTrapState } from '../utils/focus-trap';
import {
  computePosition,
  type Align,
  type ComputePositionOptions,
  type PositionResult,
  type RectLike,
  type Side,
} from '../utils/position';
import { createPresenceManager } from '../utils/presence';
import { type ChangeMeta, createStore } from './shared';
import type { DialogChangeReason } from './dialog';

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChangeDetail?: (open: boolean, reason: DialogChangeReason) => void;
  modal?: boolean;
  closeOnEscape?: boolean;
  closeOnOutsideInteraction?: boolean;
  trapFocus?: boolean;
  scrollLock?: boolean;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  collisionDetection?: boolean;
  initialFocusId?: string;
  returnFocusId?: string;
  reducedMotion?: boolean;
}

export interface PopoverState {
  open: boolean;
  modal: boolean;
  trapFocus: boolean;
  scrollLock: boolean;
  scrollLocked: boolean;
  closeOnEscape: boolean;
  closeOnOutsideInteraction: boolean;
  focusedElementId: string | null;
  returnFocusId: string | null;
  position: PositionResult | null;
  side: Side;
  align: Align;
  sideOffset: number;
  alignOffset: number;
  collisionPadding: number;
  collisionDetection: boolean;
  cleanup: {
    timers: number;
    listeners: number;
    complete: boolean;
  };
  lastChangeReason: DialogChangeReason | null;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface PopoverActions {
  setOpen: (open: boolean, reason?: DialogChangeReason) => void;
  toggle: () => void;
  syncOpen: (open: boolean) => void;
  onEscapeKeyDown: () => boolean;
  onOutsideInteraction: () => boolean;
  computePosition: (
    anchorRect: RectLike,
    contentRect: RectLike,
    viewport: { width: number; height: number; scrollX?: number; scrollY?: number }
  ) => PositionResult;
  setReturnFocus: (focusId: string | null) => void;
  setInitialFocus: (focusId: string | null) => void;
  registerTimer: () => void;
  clearTimer: () => void;
  registerListener: () => void;
  clearListener: () => void;
  cleanup: () => void;
}

export interface PopoverMachine {
  readonly state: PopoverState;
  readonly actions: PopoverActions;
  getState: () => PopoverState;
  subscribe: (
    callback: (state: PopoverState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

function resolveChangeReason(nextOpen: boolean, reason?: DialogChangeReason): DialogChangeReason {
  if (reason) {
    return reason;
  }

  return nextOpen ? 'open-programmatic' : 'close-programmatic';
}

export function createPopover(props: PopoverProps): PopoverMachine {
  const open = props.open ?? props.defaultOpen ?? false;
  const modal = props.modal ?? false;
  const trapFocus = props.trapFocus ?? modal;
  const scrollLock = props.scrollLock ?? modal;
  const side = props.side ?? 'bottom';
  const align = props.align ?? 'center';
  const sideOffset = props.sideOffset ?? 5;
  const alignOffset = props.alignOffset ?? 0;
  const collisionPadding = props.collisionPadding ?? 5;
  const collisionDetection = props.collisionDetection ?? true;

  const initialFocusId = props.initialFocusId ?? 'popover-content';
  const store = createStore<PopoverState, boolean>({
    open,
    modal,
    trapFocus,
    scrollLock,
    scrollLocked: open && modal && scrollLock,
    closeOnEscape: props.closeOnEscape ?? true,
    closeOnOutsideInteraction: props.closeOnOutsideInteraction ?? true,
    focusedElementId: open ? initialFocusId : null,
    returnFocusId: props.returnFocusId ?? null,
    position: null,
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    collisionDetection,
    cleanup: {
      timers: 0,
      listeners: 0,
      complete: !open,
    },
    lastChangeReason: null,
    lastError: null,
  });

  const focusTrap = createFocusTrapState({
    active: open && trapFocus,
    entryFocusId: open ? initialFocusId : null,
    returnFocusId: props.returnFocusId ?? null,
  });
  const presence = createPresenceManager(open, {
    reducedMotion: props.reducedMotion ?? false,
  });

  const patchCleanup = () => {
    const state = presence.getState();
    store.patchState({
      cleanup: {
        timers: state.timers,
        listeners: state.listeners,
        complete: state.cleanupComplete,
      },
    });
  };

  const applyOpenChange = (
    nextOpen: boolean,
    reason: DialogChangeReason,
    source: ChangeMeta<boolean>['source'],
    inputModality?: ChangeMeta<boolean>['inputModality']
  ) => {
    const state = store.getState();
    const previousValue = state.open;

    if (previousValue === nextOpen && state.lastChangeReason === reason) {
      return;
    }

    const meta: ChangeMeta<boolean> = {
      source,
      reason,
      previousValue,
      nextValue: nextOpen,
      inputModality,
    };

    if (nextOpen) {
      const trapState = state.trapFocus
        ? focusTrap.activate({
            entryFocusId: state.focusedElementId ?? 'popover-content',
            returnFocusId: state.returnFocusId,
          })
        : focusTrap.getState();
      presence.setPresent(true);
      store.patchState(
        {
          open: true,
          scrollLocked: state.modal && state.scrollLock,
          focusedElementId: trapState.currentFocusId ?? 'popover-content',
          returnFocusId: trapState.returnFocusId,
          cleanup: {
            timers: presence.getState().timers,
            listeners: presence.getState().listeners,
            complete: presence.getState().cleanupComplete,
          },
          lastChangeReason: reason,
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
    } else {
      const trapState = state.trapFocus
        ? focusTrap.deactivate({ restoreFocus: true })
        : focusTrap.getState();
      presence.setPresent(false);
      presence.cleanup();
      store.patchState(
        {
          open: false,
          scrollLocked: false,
          focusedElementId: trapState.currentFocusId,
          returnFocusId: trapState.returnFocusId,
          cleanup: {
            timers: presence.getState().timers,
            listeners: presence.getState().listeners,
            complete: presence.getState().cleanupComplete,
          },
          lastChangeReason: reason,
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
    }

    props.onOpenChange?.(nextOpen);
    props.onOpenChangeDetail?.(nextOpen, reason);
  };

  const actions: PopoverActions = {
    setOpen(nextOpen, reason) {
      applyOpenChange(nextOpen, resolveChangeReason(nextOpen, reason), 'programmatic');
    },
    toggle() {
      const state = store.getState();
      actions.setOpen(!state.open);
    },
    syncOpen(nextOpen) {
      applyOpenChange(
        nextOpen,
        nextOpen ? 'open-controlled-sync' : 'close-controlled-sync',
        'controlled-sync'
      );
    },
    onEscapeKeyDown() {
      const state = store.getState();
      if (!state.open || !state.closeOnEscape) {
        return false;
      }

      applyOpenChange(false, 'close-escape', 'user', 'keyboard');
      return true;
    },
    onOutsideInteraction() {
      const state = store.getState();
      if (!state.open || !state.closeOnOutsideInteraction) {
        return false;
      }

      applyOpenChange(false, 'close-outside-click', 'user', 'pointer');
      return true;
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
              component: 'Popover',
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
    setReturnFocus(focusId) {
      const trapState = focusTrap.setReturnFocus(focusId);
      store.patchState({
        returnFocusId: trapState.returnFocusId,
      });
    },
    setInitialFocus(focusId) {
      const trapState = focusTrap.recordFocus(focusId);
      store.patchState({
        focusedElementId: trapState.currentFocusId,
      });
    },
    registerTimer() {
      presence.registerTimer();
      patchCleanup();
    },
    clearTimer() {
      presence.clearTimer();
      patchCleanup();
    },
    registerListener() {
      presence.registerListener();
      patchCleanup();
    },
    clearListener() {
      presence.clearListener();
      patchCleanup();
    },
    cleanup() {
      presence.cleanup();
      patchCleanup();
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
