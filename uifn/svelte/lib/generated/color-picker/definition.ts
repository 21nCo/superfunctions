import { createColorPickerController, type ColorPickerProps } from '@uifn/core/primitives/color-picker';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnPopupAdapterBinding, createUIFnRangeGestureAdapterBinding, createUIFnRovingFocusAdapterBinding, uifnColorPickerGestureDriver, uifnPopupTriggerRovingTarget } from '@uifn/dom';

export const ColorPickerDefinition: SveltePrimitiveDefinition<ColorPickerProps> = {
  name: 'ColorPicker',
  family: 'date-color',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","open","defaultOpen","colorSpace","alpha","name","disabled","readOnly"],
  contextKey: Symbol('uifn.ColorPicker'),
  createController: createColorPickerController as never,
  domBindings: [/* @__PURE__ */ createUIFnPopupAdapterBinding({"trigger":"trigger","reference":["control","input","trigger"]}), /* @__PURE__ */ createUIFnRovingFocusAdapterBinding(uifnPopupTriggerRovingTarget), /* @__PURE__ */ createUIFnRangeGestureAdapterBinding(uifnColorPickerGestureDriver, {"parts":["area"],"entries":["channelSlider"]})],
};
