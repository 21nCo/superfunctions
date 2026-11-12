import { createPopoverController, type PopoverProps } from '@uifn/core/primitives/popover';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { overlayDomBinding } from '../../internal/dom-bindings.js';

export const PopoverDefinition: SveltePrimitiveDefinition<PopoverProps> = {
  name: 'Popover',
  family: 'modal-overlay',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","modal","placement","closeOnEscape","closeOnInteractOutside"],
  contextKey: Symbol('uifn.Popover'),
  createController: createPopoverController as never,
  domBindings: [overlayDomBinding],
};
