// The @uifn/dom bindings each headless adapter primitive wires, shared by the React (phase 11), Svelte (phase 12)
// and Solid (phase 13) generators. Each generated definition imports only the installers listed here, so an app
// that imports one primitive bundles only that primitive's DOM bindings (and floating-ui only when one of them
// positions a popup). The installers live in each adapter's internal/dom-bindings module, under these names, and
// run in this order; the predicates are the conditions the adapter compounds used before installers existed.

const ROVING_FOCUS_PRIMITIVES = new Set([
  'CheckboxGroup', 'ColorPicker', 'Editable', 'Listbox', 'Menubar', 'NavigationMenu', 'Pagination', 'PinInput',
  'RadioGroup', 'SegmentGroup', 'Tabs', 'ToggleGroup', 'Toolbar', 'TreeView',
]);
const RANGE_GESTURE_PRIMITIVES = new Set([
  'AngleSlider', 'Carousel', 'ColorPicker', 'ImageCropper', 'ScrollArea', 'SignaturePad', 'Slider', 'Splitter',
]);
const POPUP_PRIMITIVES = new Set(['Autocomplete', 'ColorPicker', 'Combobox', 'DatePicker', 'Select']);
const MENU_PRIMITIVES = new Set(['ContextMenu', 'Menu']);

export const UIFN_ADAPTER_DOM_BINDINGS = Object.freeze([
  { installer: 'overlayDomBinding', applies: (primitive) => primitive.behaviorFamily === 'modal-overlay' },
  { installer: 'menuDomBinding', applies: (primitive) => MENU_PRIMITIVES.has(primitive.name) },
  { installer: 'popupDomBinding', applies: (primitive) => POPUP_PRIMITIVES.has(primitive.name) },
  { installer: 'navigationMenuDomBinding', applies: (primitive) => primitive.name === 'NavigationMenu' },
  { installer: 'rovingFocusDomBinding', applies: (primitive) => ROVING_FOCUS_PRIMITIVES.has(primitive.name) },
  { installer: 'rangeGestureDomBinding', applies: (primitive) => RANGE_GESTURE_PRIMITIVES.has(primitive.name) },
]);

/** Installer names for a catalog primitive, in installation order. */
export function adapterDomBindings(primitive) {
  return UIFN_ADAPTER_DOM_BINDINGS.filter((entry) => entry.applies(primitive)).map((entry) => entry.installer);
}

/** The import statement and definition field a generated adapter module needs, or empty strings for none. */
export function adapterDomBindingsSource(primitive, specifier) {
  const installers = adapterDomBindings(primitive);
  if (!installers.length) return { importLine: '', field: '' };
  return {
    importLine: `import { ${installers.join(', ')} } from '${specifier}';\n`,
    field: `\n  domBindings: [${installers.join(', ')}],`,
  };
}
