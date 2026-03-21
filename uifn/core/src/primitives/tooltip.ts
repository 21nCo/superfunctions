import { createUIFnError, type UIFnError } from '../errors';
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

export interface TooltipProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  skipDelayDuration?: number;
  disableHoverableContent?: boolean;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  collisionDetection?: boolean;
  reducedMotion?: boolean;
}

export interface TooltipState {
  open: boolean;
  delayDuration: number;
  skipDelayDuration: number;
  disableHoverableContent: boolean;
  pendingOpenMs: number | null;
  side: Side;
  align: Align;
  sideOffset: number;
  alignOffset: number;
  collisionPadding: number;
  collisionDetection: boolean;
  position: PositionResult | null;
  cleanup: {
    timers: number;
    listeners: number;
    complete: boolean;
  };
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface TooltipActions {
  setOpen: (open: boolean) => void;
  openWithDelay: () => void;
  close: () => void;
  advanceTime: (elapsedMs: number) => void;
  computePosition: (
    anchorRect: RectLike,
    contentRect: RectLike,
    viewport: { width: number; height: number; scrollX?: number; scrollY?: number }
  ) => PositionResult;
  registerListener: () => void;
  clearListener: () => void;
}

export interface TooltipMachine {
  readonly state: TooltipState;
  readonly actions: TooltipActions;
  getState: () => TooltipState;
  subscribe: (
    callback: (state: TooltipState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

function patchCleanup(
  store: ReturnType<typeof createStore<TooltipState, boolean>>,
  presence: ReturnType<typeof createPresenceManager>
) {
  const presenceState = presence.getState();
  store.patchState({
    cleanup: {
      timers: presenceState.timers,
      listeners: presenceState.listeners,
      complete: presenceState.cleanupComplete,
    },
  });
}

export function createTooltip(props: TooltipProps): TooltipMachine {
  const open = props.open ?? props.defaultOpen ?? false;
  const delayDuration = props.delayDuration ?? 700;
  const skipDelayDuration = props.skipDelayDuration ?? 300;
  const store = createStore<TooltipState, boolean>({
    open,
    delayDuration,
    skipDelayDuration,
    disableHoverableContent: props.disableHoverableContent ?? false,
    pendingOpenMs: null,
    side: props.side ?? 'bottom',
    align: props.align ?? 'center',
    sideOffset: props.sideOffset ?? 5,
    alignOffset: props.alignOffset ?? 0,
    collisionPadding: props.collisionPadding ?? 5,
    collisionDetection: props.collisionDetection ?? true,
    position: null,
    cleanup: {
      timers: 0,
      listeners: 0,
      complete: !open,
    },
    lastError: null,
  });

  const presence = createPresenceManager(open, {
    reducedMotion: props.reducedMotion ?? false,
  });

  const applyOpen = (
    nextOpen: boolean,
    reason: string,
    source: ChangeMeta<boolean>['source'],
    inputModality?: ChangeMeta<boolean>['inputModality']
  ) => {
    const state = store.getState();
    if (state.open === nextOpen && state.pendingOpenMs === null) {
      return;
    }

    const meta: ChangeMeta<boolean> = {
      source,
      reason,
      previousValue: state.open,
      nextValue: nextOpen,
      inputModality,
    };

    presence.setPresent(nextOpen);
    if (!nextOpen) {
      presence.cleanup();
    }

    store.patchState(
      {
        open: nextOpen,
        pendingOpenMs: null,
        cleanup: {
          timers: presence.getState().timers,
          listeners: presence.getState().listeners,
          complete: presence.getState().cleanupComplete,
        },
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );

    props.onOpenChange?.(nextOpen);
  };

  const actions: TooltipActions = {
    setOpen(nextOpen) {
      applyOpen(nextOpen, nextOpen ? 'open-programmatic' : 'close-programmatic', 'programmatic');
    },
    openWithDelay() {
      const state = store.getState();
      if (state.delayDuration <= 0) {
        applyOpen(true, 'open-hover', 'user', 'pointer');
        return;
      }

      if (state.pendingOpenMs === null) {
        presence.registerTimer();
      }

      store.patchState({
        pendingOpenMs: state.delayDuration,
      });
      patchCleanup(store, presence);
    },
    close() {
      if (store.getState().pendingOpenMs !== null) {
        presence.clearTimer();
      }
      applyOpen(false, 'close-pointer-leave', 'user', 'pointer');
    },
    advanceTime(elapsedMs) {
      const state = store.getState();
      if (state.pendingOpenMs === null) {
        return;
      }

      const remaining = Math.max(0, state.pendingOpenMs - elapsedMs);
      if (remaining === 0) {
        presence.clearTimer();
        patchCleanup(store, presence);
        applyOpen(true, 'open-hover-delayed', 'user', 'pointer');
        return;
      }

      store.patchState({
        pendingOpenMs: remaining,
      });
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
              component: 'Tooltip',
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
    registerListener() {
      presence.registerListener();
      patchCleanup(store, presence);
    },
    clearListener() {
      presence.clearListener();
      patchCleanup(store, presence);
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
