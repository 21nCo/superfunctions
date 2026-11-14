import { createDialogController, type DialogProps } from '@uifn/core/primitives/dialog';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { uifnOverlayAdapterBinding } from '@uifn/dom';

export const DialogDefinition: SveltePrimitiveDefinition<DialogProps> = {
  name: 'Dialog',
  family: 'modal-overlay',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","modal","initialFocus","restoreFocus"],
  contextKey: Symbol('uifn.Dialog'),
  createController: createDialogController as never,
  domBindings: [uifnOverlayAdapterBinding],
};
