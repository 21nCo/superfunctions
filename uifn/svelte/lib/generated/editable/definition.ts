import { createEditableController, type EditableProps } from '@uifn/core/primitives/editable';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRovingFocusAdapterBinding, uifnEditableRovingTarget } from '@uifn/dom';

export const EditableDefinition: SveltePrimitiveDefinition<EditableProps> = {
  name: 'Editable',
  family: 'forms-input',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","editing","defaultEditing","name","disabled","readOnly","required"],
  contextKey: Symbol('uifn.Editable'),
  createController: createEditableController as never,
  domBindings: [/* @__PURE__ */ createUIFnRovingFocusAdapterBinding(uifnEditableRovingTarget)],
};
