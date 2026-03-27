import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { composePublicId, generateId, registerPublicId } from '../utils/id';
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

export interface HoverCardState {
  open: boolean;
  controlled: boolean;
  ids: {
    baseId: string;
    triggerId: string;
    contentId: string;
  };
  openDelay: number;
  closeDelay: number;
  pendingOpenMs: number | null;
  pendingCloseMs: number | null;
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

export interface HoverCardActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  openWithDelay: () => void;
  closeWithDelay: () => void;
  cancelClose: () => void;
  advanceTime: (elapsedMs: number) => void;
  computePosition: (
    anchorRect: RectLike,
    contentRect: RectLike,
    viewport: { width: number; height: number; scrollX?: number; scrollY?: number }
  ) => PositionResult;
  registerListener: () => void;
  clearListener: () => void;
}

export interface HoverCardMachine {
  readonly state: HoverCardState;
  readonly actions: HoverCardActions;
  getState: () => HoverCardState;
  subscribe: (
    callback: (state: HoverCardState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

export interface CreateHoverCardProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  idBase?: string;
  openDelay?: number;
  closeDelay?: number;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  collisionDetection?: boolean;
  reducedMotion?: boolean;
}

function patchCleanup(
  store: ReturnType<typeof createStore<HoverCardState, boolean>>,
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

export function createHoverCard(props: CreateHoverCardProps = {}): HoverCardMachine {
  const openController = createControllableStateController<boolean>({
    value: props.open,
    defaultValue: props.defaultOpen ?? false,
    onChange: props.onOpenChange,
  });
  const open = openController.getValue();
  const baseId = props.idBase
    ? registerPublicId(props.idBase, {
        package: '@uifn/core',
        component: 'HoverCard',
      })
    : generateId('hover-card');
  const store = createStore<HoverCardState, boolean>({
    open,
    controlled: openController.isControlled(),
    ids: {
      baseId,
      triggerId: registerPublicId(composePublicId({ prefix: baseId, slot: 'trigger' })),
      contentId: registerPublicId(composePublicId({ prefix: baseId, slot: 'content' })),
    },
    openDelay: props.openDelay ?? 700,
    closeDelay: props.closeDelay ?? 300,
    pendingOpenMs: null,
    pendingCloseMs: null,
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
    if (
      state.open === nextOpen &&
      state.pendingOpenMs === null &&
      state.pendingCloseMs === null
    ) {
      return;
    }

    const meta: ChangeMeta<boolean> = {
      source,
      reason,
      previousValue: state.open,
      nextValue: nextOpen,
      inputModality,
    };
    const result =
      source === 'controlled-sync'
        ? openController.syncValue(nextOpen)
        : openController.requestValue(nextOpen);

    presence.setPresent(nextOpen);
    if (!nextOpen) {
      presence.cleanup();
    }

    store.patchState(
      {
        open: result.value,
        pendingOpenMs: null,
        pendingCloseMs: null,
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
  };

  const actions: HoverCardActions = {
    open() {
      applyOpen(true, 'open-programmatic', 'programmatic');
    },
    close() {
      if (store.getState().pendingOpenMs !== null) {
        presence.clearTimer();
      }
      if (store.getState().pendingCloseMs !== null) {
        presence.clearTimer();
      }
      applyOpen(false, 'close-programmatic', 'programmatic');
    },
    toggle() {
      const state = store.getState();
      if (state.open) {
        actions.close();
      } else {
        actions.open();
      }
    },
    setOpen(nextOpen) {
      if (nextOpen) {
        actions.open();
      } else {
        actions.close();
      }
    },
    openWithDelay() {
      const state = store.getState();
      if (state.pendingCloseMs !== null) {
        presence.clearTimer();
      }

      if (state.openDelay <= 0) {
        applyOpen(true, 'open-hover', 'user', 'pointer');
        return;
      }

      if (state.pendingOpenMs === null) {
        presence.registerTimer();
      }

      store.patchState({
        pendingOpenMs: state.openDelay,
        pendingCloseMs: null,
      });
      patchCleanup(store, presence);
    },
    closeWithDelay() {
      const state = store.getState();
      if (state.pendingOpenMs !== null) {
        presence.clearTimer();
      }

      if (state.closeDelay <= 0) {
        applyOpen(false, 'close-hover', 'user', 'pointer');
        return;
      }

      if (state.pendingCloseMs === null) {
        presence.registerTimer();
      }

      store.patchState({
        pendingOpenMs: null,
        pendingCloseMs: state.closeDelay,
      });
      patchCleanup(store, presence);
    },
    cancelClose() {
      const state = store.getState();
      if (state.pendingCloseMs !== null) {
        presence.clearTimer();
      }

      store.patchState({
        pendingCloseMs: null,
      });
      patchCleanup(store, presence);
    },
    advanceTime(elapsedMs) {
      const state = store.getState();

      if (state.pendingOpenMs !== null) {
        const remainingOpen = Math.max(0, state.pendingOpenMs - elapsedMs);
        if (remainingOpen === 0) {
          presence.clearTimer();
          patchCleanup(store, presence);
          applyOpen(true, 'open-hover-delayed', 'user', 'pointer');
          return;
        }

        store.patchState({
          pendingOpenMs: remainingOpen,
        });
      }

      const nextState = store.getState();
      if (nextState.pendingCloseMs !== null) {
        const remainingClose = Math.max(0, nextState.pendingCloseMs - elapsedMs);
        if (remainingClose === 0) {
          presence.clearTimer();
          patchCleanup(store, presence);
          applyOpen(false, 'close-hover-delayed', 'user', 'pointer');
          return;
        }

        store.patchState({
          pendingCloseMs: remainingClose,
        });
      }
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
              component: 'HoverCard',
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
