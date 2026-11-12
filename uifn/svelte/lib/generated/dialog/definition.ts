import { createDialogController, type DialogProps } from '@uifn/core/primitives/dialog';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { overlayDomBinding } from '../../internal/dom-bindings.js';

export const DialogDefinition: SveltePrimitiveDefinition<DialogProps> = {
  name: 'Dialog',
  family: 'modal-overlay',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","modal","initialFocus","restoreFocus"],
  contextKey: Symbol('uifn.Dialog'),
  createController: createDialogController as never,
  domBindings: [overlayDomBinding],
};
