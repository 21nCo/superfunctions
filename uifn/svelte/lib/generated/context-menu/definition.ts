import { createContextMenuController, type ContextMenuProps } from '@uifn/core/primitives/context-menu';
import type { SveltePrimitiveDefinition } from '../../internal/compound.js';
import { uifnMenuAdapterBinding } from '@uifn/dom';

export const ContextMenuDefinition: SveltePrimitiveDefinition<ContextMenuProps> = {
  name: 'ContextMenu',
  family: 'menu-navigation',
  kind: 'interactive-controller',
  rootPart: 'root',
  inputNames: ["open","defaultOpen","dir","loop"],
  contextKey: Symbol('uifn.ContextMenu'),
  createController: createContextMenuController as never,
  domBindings: [uifnMenuAdapterBinding],
};
