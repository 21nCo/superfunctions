import { createSliderController, type SliderProps } from '@uifn/core/primitives/slider';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRangeGestureAdapterBinding, uifnSliderGestureDriver } from '@uifn/dom';

export const SliderDefinition: SveltePrimitiveDefinition<SliderProps> = {
  name: 'Slider',
  family: 'range-gesture',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","min","max","step","minStepsBetweenThumbs","orientation","dir","name","disabled","readOnly"],
  contextKey: Symbol('uifn.Slider'),
  createController: createSliderController as never,
  domBindings: [/* @__PURE__ */ createUIFnRangeGestureAdapterBinding(uifnSliderGestureDriver, {"parts":["control"]})],
};
