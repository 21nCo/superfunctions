import { createCarouselController, type CarouselProps } from '@uifn/core/primitives/carousel';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRangeGestureAdapterBinding, uifnCarouselGestureDriver } from '@uifn/dom';

export const CarouselDefinition: SveltePrimitiveDefinition<CarouselProps> = {
  name: 'Carousel',
  family: 'range-gesture',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["index","defaultIndex","itemCount","loop","orientation","autoplayDelay","dir"],
  contextKey: Symbol('uifn.Carousel'),
  createController: createCarouselController as never,
  domBindings: [/* @__PURE__ */ createUIFnRangeGestureAdapterBinding(uifnCarouselGestureDriver, {"parts":["viewport"]})],
};
