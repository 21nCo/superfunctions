import { createAlertDialogController, type AlertDialogProps } from '@uifn/core/primitives/alert-dialog';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { overlayDomBinding } from '../../internal/dom-bindings.js';

export const AlertDialogDefinition: SveltePrimitiveDefinition<AlertDialogProps> = {
  name: 'AlertDialog',
  family: 'modal-overlay',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","initialFocus","restoreFocus"],
  contextKey: Symbol('uifn.AlertDialog'),
  createController: createAlertDialogController as never,
  domBindings: [overlayDomBinding],
};
