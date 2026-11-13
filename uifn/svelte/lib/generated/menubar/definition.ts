import { createMenubarController, type MenubarProps } from '@uifn/core/primitives/menubar';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRovingFocusAdapterBinding, uifnMenubarRovingTarget } from '@uifn/dom';

export const MenubarDefinition: SveltePrimitiveDefinition<MenubarProps> = {
  name: 'Menubar',
  family: 'menu-navigation',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","loop","dir"],
  contextKey: Symbol('uifn.Menubar'),
  createController: createMenubarController as never,
  domBindings: [/* @__PURE__ */ createUIFnRovingFocusAdapterBinding(uifnMenubarRovingTarget)],
};
