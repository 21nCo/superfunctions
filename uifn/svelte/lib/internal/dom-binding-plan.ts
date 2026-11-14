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
  /** The @uifn/dom gesture driver passed to `factory` before `descriptor`. */
  readonly driver?: string;
}

const ITEM_CONTROLS = { stateKey: 'focusedItem', parts: ['itemControl', 'item'] };
export const ROVING_FOCUS: Readonly<Record<string, string | Readonly<Record<string, unknown>>>> = {
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
export const RANGE_GESTURE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
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
export const POPUP: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
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
  if (RANGE_GESTURE[name]) {
    specs.push({ ...described('rangeGestureDomBinding', 'createUIFnRangeGestureAdapterBinding', RANGE_GESTURE[name]), driver: `uifn${name}GestureDriver` });
  }
  return specs;
}
