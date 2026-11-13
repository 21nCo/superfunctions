// The @uifn/dom bindings each catalog primitive's generated definition lists, as data. This mirrors
// scripts/uifn-adapter-dom-bindings.mjs (tests/dom-bindings-public.test.ts keeps them equal) and backs only the
// public `@uifn/svelte/dom-bindings` helpers for hand-built definitions; generated definitions never import it.

export type SvelteDomBindingKind =
  | 'overlayDomBinding'
  | 'menuDomBinding'
  | 'popupDomBinding'
  | 'navigationMenuDomBinding'
  | 'rovingFocusDomBinding'
  | 'rangeGestureDomBinding';

export interface SvelteDomBindingSpec {
  readonly installer: SvelteDomBindingKind;
  /** A ready @uifn/dom installer. */
  readonly ready?: string;
  /** A @uifn/dom installer factory, called with `descriptor` or the @uifn/dom roving `target`. */
  readonly factory?: string;
  readonly descriptor?: Readonly<Record<string, unknown>>;
  readonly target?: string;
}

const ITEM_CONTROLS = { stateKey: 'focusedItem', parts: ['itemControl', 'item'] };
const ROVING_FOCUS: Readonly<Record<string, string | Readonly<Record<string, unknown>>>> = {
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
};
const RANGE_GESTURE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  AngleSlider: { parts: ['track'] },
  Carousel: { parts: ['viewport'] },
  ColorPicker: { parts: ['area'], entries: ['channelSlider'] },
  ImageCropper: { parts: ['cropArea'], entries: ['handle'] },
  ScrollArea: { entries: ['thumb'] },
  SignaturePad: { parts: ['canvas'] },
  Slider: { parts: ['control'] },
  Splitter: { entries: ['resizeHandle'], numericEntryValues: true },
};
const CONTROL_REFERENCE = ['control', 'input', 'trigger'];
const POPUP: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  Autocomplete: { trigger: 'input', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
  ColorPicker: { trigger: 'trigger', reference: CONTROL_REFERENCE },
  Combobox: { trigger: 'trigger', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
  DatePicker: { trigger: 'trigger', reference: ['input', 'trigger'] },
  Select: { trigger: 'trigger', reference: CONTROL_REFERENCE, matchReferenceWidth: true },
};

function described(installer: SvelteDomBindingKind, factory: string, descriptor: string | Readonly<Record<string, unknown>>): SvelteDomBindingSpec {
  return typeof descriptor === 'string' ? { installer, factory, target: descriptor } : { installer, factory, descriptor };
}

/** The bindings, in installation order, for a definition with this catalog `name` and `family`. */
export function svelteDomBindingSpecs(target: { readonly name: string; readonly family: string }): readonly SvelteDomBindingSpec[] {
  const { name } = target;
  const specs: SvelteDomBindingSpec[] = [];
  if (target.family === 'modal-overlay') {
    specs.push({ installer: 'overlayDomBinding', ready: name === 'Tour' ? 'uifnTourOverlayAdapterBinding' : 'uifnOverlayAdapterBinding' });
  }
  if (name === 'ContextMenu' || name === 'Menu') specs.push({ installer: 'menuDomBinding', ready: 'uifnMenuAdapterBinding' });
  if (POPUP[name]) specs.push(described('popupDomBinding', 'createUIFnPopupAdapterBinding', POPUP[name]));
  if (name === 'NavigationMenu') specs.push({ installer: 'navigationMenuDomBinding', ready: 'uifnNavigationMenuAdapterBinding' });
  if (ROVING_FOCUS[name]) specs.push(described('rovingFocusDomBinding', 'createUIFnRovingFocusAdapterBinding', ROVING_FOCUS[name]));
  if (RANGE_GESTURE[name]) specs.push(described('rangeGestureDomBinding', 'createUIFnRangeGestureAdapterBinding', RANGE_GESTURE[name]));
  return specs;
}

/**
 * The binding one public installer wires for a definition named `name`, whatever its family. Overlay, menu and
 * navigation-menu installers work for any name; a popup without catalog parts toggles and anchors to `trigger`;
 * roving focus and range gestures need the catalog primitive's parts, so other names get none.
 */
export function svelteDomBindingSpecFor(installer: SvelteDomBindingKind, name: string): SvelteDomBindingSpec | null {
  switch (installer) {
    case 'overlayDomBinding':
      return { installer, ready: name === 'Tour' ? 'uifnTourOverlayAdapterBinding' : 'uifnOverlayAdapterBinding' };
    case 'menuDomBinding':
      return { installer, ready: 'uifnMenuAdapterBinding' };
    case 'navigationMenuDomBinding':
      return { installer, ready: 'uifnNavigationMenuAdapterBinding' };
    case 'popupDomBinding':
      return described(installer, 'createUIFnPopupAdapterBinding', POPUP[name] ?? { trigger: 'trigger', reference: ['trigger'] });
    case 'rovingFocusDomBinding':
      return ROVING_FOCUS[name] ? described(installer, 'createUIFnRovingFocusAdapterBinding', ROVING_FOCUS[name]) : null;
    case 'rangeGestureDomBinding':
      return RANGE_GESTURE[name] ? described(installer, 'createUIFnRangeGestureAdapterBinding', RANGE_GESTURE[name]) : null;
  }
}
