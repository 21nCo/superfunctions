import { createScrollAreaController, type ScrollAreaProps } from '@uifn/core/primitives/scroll-area';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { rangeGestureDomBinding } from '../../internal/dom-bindings.js';

export const ScrollAreaDefinition: SveltePrimitiveDefinition<ScrollAreaProps> = {
  name: 'ScrollArea',
  family: 'range-gesture',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["type","scrollHideDelay","orientation","dir"],
  contextKey: Symbol('uifn.ScrollArea'),
  createController: createScrollAreaController as never,
  domBindings: [rangeGestureDomBinding],
};
