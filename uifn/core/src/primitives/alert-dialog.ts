import {
  createDialog,
  type DialogActions,
  type DialogChangeReason,
  type DialogMachine,
  type DialogProps,
  type DialogState,
} from './dialog';

export interface AlertDialogProps
  extends Omit<DialogProps, 'role' | 'outsideInteractionBehavior' | 'modal'> {}

export interface AlertDialogState extends DialogState {}

export interface AlertDialogActions extends DialogActions {}

export interface AlertDialogMachine
  extends Omit<DialogMachine, 'actions' | 'state' | 'getState' | 'setOpen'> {
  readonly state: AlertDialogState;
  readonly actions: AlertDialogActions;
  setOpen: (open: boolean, reason?: DialogChangeReason) => void;
  getState: () => AlertDialogState;
}

export function createAlertDialog(props: AlertDialogProps): AlertDialogMachine {
  const dialog = createDialog({
    ...props,
    role: 'alertdialog',
    modal: true,
    outsideInteractionBehavior: 'disallow',
    closeOnOutsideInteraction: false,
  });

  return {
    get state() {
      return dialog.state;
    },
    actions: dialog.actions,
    setOpen: dialog.setOpen,
    getState: dialog.getState,
    subscribe: dialog.subscribe,
  };
}
