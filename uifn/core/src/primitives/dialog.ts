import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { createFocusTrapState } from '../utils/focus-trap';
import { composePublicId, generateId, registerPublicId } from '../utils/id';
import { type ChangeMeta, createStore } from './shared';

export type DialogOpenReason =
  | 'open-trigger'
  | 'open-programmatic'
  | 'open-controlled-sync';

export type DialogCloseReason =
  | 'close-escape'
  | 'close-outside-click'
  | 'close-trigger'
  | 'close-programmatic'
  | 'close-controlled-sync';

export type DialogChangeReason = DialogOpenReason | DialogCloseReason;

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChangeDetail?: (open: boolean, reason: DialogChangeReason) => void;
  idBase?: string;
  modal?: boolean;
  closeOnEscape?: boolean;
  closeOnOutsideInteraction?: boolean;
  outsideInteractionBehavior?: 'close' | 'ignore' | 'disallow';
  trapFocus?: boolean;
  scrollLock?: boolean;
  initialFocusId?: string;
  returnFocusId?: string;
  role?: 'dialog' | 'alertdialog';
}

export interface DialogIds {
  baseId: string;
  triggerId: string;
  contentId: string;
  titleId: string;
  descriptionId: string;
}

export interface DialogState {
  open: boolean;
  controlled: boolean;
  modal: boolean;
  trapFocus: boolean;
  focusTrapActive: boolean;
  scrollLock: boolean;
  scrollLocked: boolean;
  closeOnEscape: boolean;
  closeOnOutsideInteraction: boolean;
  outsideInteractionBehavior: 'close' | 'ignore' | 'disallow';
  role: 'dialog' | 'alertdialog';
  ids: DialogIds;
  focusedElementId: string | null;
  returnFocusId: string | null;
  lastChangeReason: DialogChangeReason | null;
  lastChangeMeta?: ChangeMeta<boolean>;
  lastError: UIFnError | null;
}

export interface DialogActions {
  setOpen: (open: boolean, reason?: DialogChangeReason) => void;
  toggle: () => void;
  open: (reason?: DialogOpenReason) => void;
  close: (reason?: DialogCloseReason) => void;
  syncOpen: (open: boolean) => void;
  setReturnFocus: (focusId: string | null) => void;
  setInitialFocus: (focusId: string | null) => void;
  onEscapeKeyDown: () => boolean;
  onOutsideInteraction: () => boolean;
}

export interface DialogMachine {
  readonly state: DialogState;
  readonly actions: DialogActions;
  setOpen: (open: boolean, reason?: DialogChangeReason) => void;
  getState: () => DialogState;
  subscribe: (
    callback: (state: DialogState, meta?: ChangeMeta<boolean>) => void
  ) => () => void;
}

function resolveChangeReason(nextOpen: boolean, provided?: DialogChangeReason): DialogChangeReason {
  if (provided) {
    return provided;
  }

  return nextOpen ? 'open-programmatic' : 'close-programmatic';
}

function createDialogIds(props: DialogProps): DialogIds {
  const rolePrefix = props.role === 'alertdialog' ? 'alert-dialog' : 'dialog';
  const baseId = props.idBase
    ? registerPublicId(props.idBase, {
        package: '@uifn/core',
        component: props.role === 'alertdialog' ? 'AlertDialog' : 'Dialog',
      })
    : generateId(rolePrefix);

  return {
    baseId,
    triggerId: registerPublicId(composePublicId({ prefix: baseId, slot: 'trigger' })),
    contentId: registerPublicId(composePublicId({ prefix: baseId, slot: 'content' })),
    titleId: registerPublicId(composePublicId({ prefix: baseId, slot: 'title' })),
    descriptionId: registerPublicId(composePublicId({ prefix: baseId, slot: 'description' })),
  };
}

function buildDialogState(
  props: DialogProps,
  open: boolean,
  controlled: boolean,
  ids: DialogIds
): DialogState {
  const modal = props.modal ?? true;
  const trapFocus = props.trapFocus ?? modal;
  const scrollLock = modal ? true : props.scrollLock ?? false;
  const closeOnEscape = props.closeOnEscape ?? true;
  const outsideInteractionBehavior =
    props.outsideInteractionBehavior ??
    (props.closeOnOutsideInteraction === false ? 'ignore' : 'close');
  const closeOnOutsideInteraction = outsideInteractionBehavior === 'close';
  const initialFocusId = props.initialFocusId ?? ids.contentId;

  return {
    open,
    controlled,
    modal,
    trapFocus,
    focusTrapActive: open && trapFocus,
    scrollLock,
    scrollLocked: open && modal && scrollLock,
    closeOnEscape,
    closeOnOutsideInteraction,
    outsideInteractionBehavior,
    role: props.role ?? 'dialog',
    ids,
    focusedElementId: open ? initialFocusId : null,
    returnFocusId: props.returnFocusId ?? null,
    lastChangeReason: null,
    lastError: null,
  };
}

export function createDialog(props: DialogProps): DialogMachine {
  const openController = createControllableStateController<boolean>({
    value: props.open,
    defaultValue: props.defaultOpen ?? false,
    onChange: props.onOpenChange,
  });
  const ids = createDialogIds(props);
  const initialState = buildDialogState(
    props,
    openController.getValue(),
    openController.isControlled(),
    ids
  );
  const store = createStore<DialogState, boolean>(initialState);
  const focusTrap = createFocusTrapState({
    active: initialState.open && initialState.trapFocus,
    entryFocusId: initialState.focusedElementId ?? initialState.ids.contentId,
    returnFocusId: initialState.returnFocusId,
  });

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

    const nextMeta: ChangeMeta<boolean> = {
      source,
      reason,
      previousValue,
      nextValue: nextOpen,
      inputModality,
    };
    const result =
      source === 'controlled-sync'
        ? openController.syncValue(nextOpen)
        : openController.requestValue(nextOpen);
    const resolvedOpen = result.value;

    if (nextOpen) {
      const trapState = state.trapFocus
        ? focusTrap.activate({
            entryFocusId: state.focusedElementId ?? state.ids.contentId,
            returnFocusId: state.returnFocusId,
          })
        : focusTrap.getState();

      store.patchState(
        {
          open: resolvedOpen,
          focusTrapActive: resolvedOpen && state.trapFocus,
          scrollLocked: resolvedOpen && state.modal && state.scrollLock,
          focusedElementId: trapState.currentFocusId ?? state.ids.contentId,
          returnFocusId: trapState.returnFocusId,
          lastChangeReason: reason,
          lastChangeMeta: nextMeta,
          lastError: null,
        },
        nextMeta
      );
    } else {
      const trapState = state.trapFocus
        ? focusTrap.deactivate({ restoreFocus: true })
        : focusTrap.getState();

      store.patchState(
        {
          open: resolvedOpen,
          focusTrapActive: false,
          scrollLocked: false,
          focusedElementId: trapState.currentFocusId,
          returnFocusId: trapState.returnFocusId,
          lastChangeReason: reason,
          lastChangeMeta: nextMeta,
          lastError: null,
        },
        nextMeta
      );
    }

    props.onOpenChangeDetail?.(nextOpen, reason);
  };

  const actions: DialogActions = {
    setOpen(nextOpen, reason) {
      const resolved = resolveChangeReason(nextOpen, reason);
      applyOpenChange(nextOpen, resolved, 'programmatic');
    },
    toggle() {
      const state = store.getState();
      actions.setOpen(!state.open);
    },
    open(reason = 'open-programmatic') {
      applyOpenChange(true, reason, reason === 'open-controlled-sync' ? 'controlled-sync' : 'programmatic');
    },
    close(reason = 'close-programmatic') {
      applyOpenChange(
        false,
        reason,
        reason === 'close-controlled-sync' ? 'controlled-sync' : 'programmatic'
      );
    },
    syncOpen(nextOpen) {
      applyOpenChange(
        nextOpen,
        nextOpen ? 'open-controlled-sync' : 'close-controlled-sync',
        'controlled-sync'
      );
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
      if (!state.open) {
        return false;
      }

      if (state.outsideInteractionBehavior === 'close') {
        applyOpenChange(false, 'close-outside-click', 'user', 'pointer');
        return true;
      }

      if (state.outsideInteractionBehavior === 'disallow') {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_INVALID_VALUE',
            package: '@uifn/core',
            component: state.role === 'alertdialog' ? 'AlertDialog' : 'Dialog',
            message: 'AlertDialog outside-click behavior MUST follow documented policy.',
            recoverable: true,
          }),
        });
      }

      return false;
    },
  };

  return {
    get state() {
      return store.getState();
    },
    actions,
    setOpen: actions.setOpen,
    getState: store.getState,
    subscribe: store.subscribe,
  };
}
