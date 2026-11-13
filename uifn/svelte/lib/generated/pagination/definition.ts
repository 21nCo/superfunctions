import { createPaginationController, type PaginationProps } from '@uifn/core/primitives/pagination';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { createUIFnRovingFocusAdapterBinding } from '@uifn/dom';

export const PaginationDefinition: SveltePrimitiveDefinition<PaginationProps> = {
  name: 'Pagination',
  family: 'menu-navigation',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["page","defaultPage","count","pageSize","siblingCount","disabled"],
  contextKey: Symbol('uifn.Pagination'),
  createController: createPaginationController as never,
  domBindings: [/* @__PURE__ */ createUIFnRovingFocusAdapterBinding({"stateKey":"focusedPage","parts":["pageTrigger"]})],
};
