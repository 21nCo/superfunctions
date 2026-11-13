import {
  menuDomBinding,
  navigationMenuDomBinding,
  overlayDomBinding,
  popupDomBinding,
  rangeGestureDomBinding,
  rovingFocusDomBinding,
  type SvelteDomBindingInstaller,
} from './internal/dom-bindings.js';

export {
  menuDomBinding,
  navigationMenuDomBinding,
  overlayDomBinding,
  popupDomBinding,
  rangeGestureDomBinding,
  rovingFocusDomBinding,
  type SvelteDomBindingContext,
  type SvelteDomBindingHandle,
  type SvelteDomBindingInstaller,
} from './internal/dom-bindings.js';

/** The fields of a primitive definition that decide which @uifn/dom bindings it wires. */
export interface SvelteDomBindingPlanTarget {
  readonly name: string;
  readonly family: string;
}

const ROVING_FOCUS_PRIMITIVES: ReadonlySet<string> = new Set([
  'CheckboxGroup', 'ColorPicker', 'Editable', 'Listbox', 'Menubar', 'NavigationMenu', 'Pagination', 'PinInput',
  'RadioGroup', 'SegmentGroup', 'Tabs', 'ToggleGroup', 'Toolbar', 'TreeView',
]);
const RANGE_GESTURE_PRIMITIVES: ReadonlySet<string> = new Set([
  'AngleSlider', 'Carousel', 'ColorPicker', 'ImageCropper', 'ScrollArea', 'SignaturePad', 'Slider', 'Splitter',
]);
const POPUP_PRIMITIVES: ReadonlySet<string> = new Set(['Autocomplete', 'ColorPicker', 'Combobox', 'DatePicker', 'Select']);
const MENU_PRIMITIVES: ReadonlySet<string> = new Set(['ContextMenu', 'Menu']);

const PLAN: ReadonlyArray<readonly [SvelteDomBindingInstaller, (target: SvelteDomBindingPlanTarget) => boolean]> = [
  [overlayDomBinding, (target) => target.family === 'modal-overlay'],
  [menuDomBinding, (target) => MENU_PRIMITIVES.has(target.name)],
  [popupDomBinding, (target) => POPUP_PRIMITIVES.has(target.name)],
  [navigationMenuDomBinding, (target) => target.name === 'NavigationMenu'],
  [rovingFocusDomBinding, (target) => ROVING_FOCUS_PRIMITIVES.has(target.name)],
  [rangeGestureDomBinding, (target) => RANGE_GESTURE_PRIMITIVES.has(target.name)],
];

/**
 * The installers the generated definition for a catalog primitive lists, in installation order, for a
 * hand-built `SveltePrimitiveDefinition` that reuses a catalog primitive's `name` and `family`. The bridge wires
 * only `definition.domBindings`, so a hand-built definition without them gets no focus trap, roving focus, popup
 * positioning or gesture handling. Importing this helper bundles every installer; import the installers you need
 * directly to keep a bundle to one primitive's bindings.
 */
export function svelteDomBindingsFor(target: SvelteDomBindingPlanTarget): readonly SvelteDomBindingInstaller[] {
  return PLAN.filter(([, applies]) => applies(target)).map(([installer]) => installer);
}
