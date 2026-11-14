import { createNavigationMenuController, type NavigationMenuProps } from '@uifn/core/primitives/navigation-menu';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRovingFocusAdapterBinding, uifnNavigationMenuAdapterBinding } from '@uifn/dom';

export const NavigationMenuDefinition: SveltePrimitiveDefinition<NavigationMenuProps> = {
  name: 'NavigationMenu',
  family: 'menu-navigation',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["value","defaultValue","orientation","delayDuration","skipDelayDuration","dir"],
  contextKey: Symbol('uifn.NavigationMenu'),
  createController: createNavigationMenuController as never,
  domBindings: [uifnNavigationMenuAdapterBinding, /* @__PURE__ */ createUIFnRovingFocusAdapterBinding({"stateKey":"focusedItem","parts":["trigger"]})],
};
