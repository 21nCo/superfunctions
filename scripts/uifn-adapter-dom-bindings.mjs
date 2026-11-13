// The @uifn/dom bindings each headless adapter primitive wires, shared by the React (phase 11), Svelte (phase 12)
// and Solid (phase 13) generators. The installers live in @uifn/dom (src/adapter-bindings.ts) and never branch on
// a primitive name: each generated definition passes its own parts, state keys and gesture driver, so an app that
// imports one primitive bundles only that primitive's installers, descriptors and driver (and floating-ui only
// when one of them positions a popup). Installers run in the order listed here.

const ITEM_CONTROLS = Object.freeze({ stateKey: 'focusedItem', parts: ['itemControl', 'item'] });

// Roving focus: a { stateKey, parts } descriptor, or the @uifn/dom target for state-dependent parts.
const ROVING_FOCUS = Object.freeze({
  CheckboxGroup: ITEM_CONTROLS,
  ColorPicker: 'uifnPopupTriggerRovingTarget',
  Editable: 'uifnEditableRovingTarget',
  Listbox: ITEM_CONTROLS,
  Menubar: 'uifnMenubarRovingTarget',
  NavigationMenu: { stateKey: 'focusedItem', parts: ['trigger'] },
  Pagination: { stateKey: 'focusedPage', parts: ['pageTrigger'] },
  PinInput: 'uifnPinInputRovingTarget',
  RadioGroup: ITEM_CONTROLS,
  SegmentGroup: ITEM_CONTROLS,
  Tabs: { stateKey: 'focusedItem', parts: ['trigger'] },
  ToggleGroup: ITEM_CONTROLS,
  Toolbar: { stateKey: 'focusedItem', parts: ['button', 'link'] },
  TreeView: { stateKey: 'focusedItem', parts: ['item'] },
});
// Range gestures: single-element surface parts, then many-part entries (with their values).
const RANGE_GESTURE = Object.freeze({
  AngleSlider: { parts: ['track'] },
  Carousel: { parts: ['viewport'] },
  ColorPicker: { parts: ['area'], entries: ['channelSlider'] },
  ImageCropper: { parts: ['cropArea'], entries: ['handle'] },
  ScrollArea: { entries: ['thumb'] },
  SignaturePad: { parts: ['canvas'] },
  Slider: { parts: ['control'] },
  Splitter: { entries: ['resizeHandle'], numericEntryValues: true },
});
const CONTROL_REFERENCE = Object.freeze(['control', 'input', 'trigger']);
// Popups: the part that toggles them and the parts they are positioned against, first registered wins.
const POPUP = Object.freeze({
  Autocomplete: { trigger: 'input', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
  ColorPicker: { trigger: 'trigger', reference: CONTROL_REFERENCE },
  Combobox: { trigger: 'trigger', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
  DatePicker: { trigger: 'trigger', reference: ['input', 'trigger'] },
  Select: { trigger: 'trigger', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
});
const MENU_PRIMITIVES = new Set(['ContextMenu', 'Menu']);

const binding = (installer, ready) => ({ installer, ready });
const described = (installer, factory, descriptor) => (
  typeof descriptor === 'string'
    ? { installer, factory, target: descriptor }
    : { installer, factory, descriptor }
);

/**
 * The bindings a catalog primitive's generated definition lists, in installation order. `installer` names the
 * kind; the definition uses `ready` (a @uifn/dom installer) or calls `factory` with `descriptor` (inline data)
 * or `target` (a @uifn/dom roving target), after the @uifn/dom gesture `driver` when there is one.
 */
export function adapterDomBindingSpecs(primitive) {
  const specs = [];
  if (primitive.behaviorFamily === 'modal-overlay') {
    specs.push(binding('overlayDomBinding', primitive.name === 'Tour' ? 'uifnTourOverlayAdapterBinding' : 'uifnOverlayAdapterBinding'));
  }
  if (MENU_PRIMITIVES.has(primitive.name)) specs.push(binding('menuDomBinding', 'uifnMenuAdapterBinding'));
  if (POPUP[primitive.name]) specs.push(described('popupDomBinding', 'createUIFnPopupAdapterBinding', POPUP[primitive.name]));
  if (primitive.name === 'NavigationMenu') specs.push(binding('navigationMenuDomBinding', 'uifnNavigationMenuAdapterBinding'));
  if (ROVING_FOCUS[primitive.name]) specs.push(described('rovingFocusDomBinding', 'createUIFnRovingFocusAdapterBinding', ROVING_FOCUS[primitive.name]));
  if (RANGE_GESTURE[primitive.name]) {
    specs.push({ ...described('rangeGestureDomBinding', 'createUIFnRangeGestureAdapterBinding', RANGE_GESTURE[primitive.name]), driver: `uifn${primitive.name}GestureDriver` });
  }
  return specs;
}

/** Installer kinds for a catalog primitive, in installation order. */
export function adapterDomBindings(primitive) {
  return adapterDomBindingSpecs(primitive).map((spec) => spec.installer);
}

function expression(spec) {
  if (spec.ready) return spec.ready;
  const driver = spec.driver ? `${spec.driver}, ` : '';
  return `/* @__PURE__ */ ${spec.factory}(${driver}${spec.target ?? JSON.stringify(spec.descriptor)})`;
}

/** The @uifn/dom import and definition field a generated adapter module needs, or empty strings for none. */
export function adapterDomBindingsSource(primitive) {
  const specs = adapterDomBindingSpecs(primitive);
  if (!specs.length) return { importLine: '', field: '' };
  const imports = [...new Set(specs.flatMap((spec) => [spec.ready, spec.factory, spec.driver, spec.target].filter(Boolean)))]
    .sort((left, right) => (left < right ? -1 : Number(left > right)));
  return {
    importLine: `import { ${imports.join(', ')} } from '@uifn/dom';\n`,
    field: `\n  domBindings: [${specs.map(expression).join(', ')}],`,
  };
}

/**
 * Wiring issues for one generated adapter definition: every planned binding must be reached from the
 * definition's `domBindings`, and nothing else may be listed there.
 */
export function adapterDomBindingWiringIssues(primitive, source) {
  const { importLine, field } = adapterDomBindingsSource(primitive);
  const listed = /\n {2}domBindings: \[.*\],/.exec(source)?.[0] ?? '';
  const issues = [];
  if (listed !== field) issues.push(`${primitive.name} domBindings must be ${field.trim() || 'absent'}, found ${listed.trim() || 'none'}`);
  if (importLine && !source.includes(importLine)) issues.push(`${primitive.name} must import ${importLine.trim()}`);
  return issues;
}

/** Issues in the shared @uifn/dom installer module, which must never name (and so never branch on) a primitive. */
export function sharedAdapterInstallerIssues(source, primitives) {
  return primitives
    .filter((primitive) => source.includes(`'${primitive.name}'`) || source.includes(`"${primitive.name}"`))
    .map((primitive) => `uifn/dom/src/adapter-bindings.ts names the ${primitive.name} primitive`);
}
