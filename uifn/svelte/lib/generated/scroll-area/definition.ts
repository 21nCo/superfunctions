import { createScrollAreaController, type ScrollAreaProps } from '@uifn/core/primitives/scroll-area';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRangeGestureAdapterBinding } from '@uifn/dom';

export const ScrollAreaDefinition: SveltePrimitiveDefinition<ScrollAreaProps> = {
  name: 'ScrollArea',
  family: 'range-gesture',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["type","scrollHideDelay","orientation","dir"],
  contextKey: Symbol('uifn.ScrollArea'),
  createController: createScrollAreaController as never,
  domBindings: [/* @__PURE__ */ createUIFnRangeGestureAdapterBinding({"entries":["thumb"]})],
};
