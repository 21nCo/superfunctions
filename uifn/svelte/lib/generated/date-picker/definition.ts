import { createDatePickerController, type DatePickerProps } from '@uifn/core/primitives/date-picker';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnPopupAdapterBinding } from '@uifn/dom';

export const DatePickerDefinition: SveltePrimitiveDefinition<DatePickerProps> = {
  name: 'DatePicker',
  family: 'date-color',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","open","defaultOpen","locale","timeZone","min","max","unavailable","name","disabled","readOnly"],
  contextKey: Symbol('uifn.DatePicker'),
  createController: createDatePickerController as never,
  domBindings: [/* @__PURE__ */ createUIFnPopupAdapterBinding({"trigger":"trigger","reference":["input","trigger"]})],
};
