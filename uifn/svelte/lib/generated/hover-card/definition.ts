import { createHoverCardController, type CreateHoverCardProps } from '@uifn/core/primitives/hover-card';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { overlayDomBinding } from '../../internal/dom-bindings.js';

export const HoverCardDefinition: SveltePrimitiveDefinition<CreateHoverCardProps> = {
  name: 'HoverCard',
  family: 'modal-overlay',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","openDelay","closeDelay","placement"],
  contextKey: Symbol('uifn.HoverCard'),
  createController: createHoverCardController as never,
  domBindings: [overlayDomBinding],
};
