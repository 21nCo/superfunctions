import {
  createUIFnPopupAdapterBinding,
  createUIFnRangeGestureAdapterBinding,
  createUIFnRovingFocusAdapterBinding,
  uifnEditableRovingTarget,
  uifnMenuAdapterBinding,
  uifnMenubarRovingTarget,
  uifnNavigationMenuAdapterBinding,
  uifnOverlayAdapterBinding,
  uifnPinInputRovingTarget,
  uifnPopupTriggerRovingTarget,
  uifnTourOverlayAdapterBinding,
  uifnAngleSliderGestureDriver,
  uifnCarouselGestureDriver,
  uifnColorPickerGestureDriver,
  uifnImageCropperGestureDriver,
  uifnScrollAreaGestureDriver,
  uifnSignaturePadGestureDriver,
  uifnSliderGestureDriver,
  uifnSplitterGestureDriver,
  type UIFnAdapterGestureParts,
  type UIFnAdapterPopupParts,
  type UIFnAdapterRovingParts,
  type UIFnAdapterRovingTarget,
  type UIFnRangeGestureDriver,
} from '@uifn/dom';
import type { SvelteDomBindingInstaller } from './internal/compound.js';
import {
  POPUP,
  RANGE_GESTURE,
  ROVING_FOCUS,
  svelteDomBindingSpecs,
  type SvelteDomBindingKind,
} from './internal/dom-binding-plan.js';

export { svelteMenubarCommitFocus } from './internal/menubar-commit-focus.js';
export type {
  SvelteCommitFocus,
  SvelteCommitFocusHandle,
  SvelteDomBindingContext,
  SvelteDomBindingHandle,
  SvelteDomBindingInstaller,
} from './internal/compound.js';

/** The fields of a primitive definition that decide which @uifn/dom bindings it wires. */
export interface SvelteDomBindingPlanTarget {
  readonly name: string;
  readonly family: string;
}

const ROVING_TARGETS: Readonly<Record<string, UIFnAdapterRovingTarget>> = {
  uifnEditableRovingTarget,
  uifnMenubarRovingTarget,
  uifnPinInputRovingTarget,
  uifnPopupTriggerRovingTarget,
};

const GESTURE_DRIVERS: Readonly<Record<string, UIFnRangeGestureDriver>> = {
  AngleSlider: uifnAngleSliderGestureDriver,
  Carousel: uifnCarouselGestureDriver,
  ColorPicker: uifnColorPickerGestureDriver,
  ImageCropper: uifnImageCropperGestureDriver,
  ScrollArea: uifnScrollAreaGestureDriver,
  SignaturePad: uifnSignaturePadGestureDriver,
  Slider: uifnSliderGestureDriver,
  Splitter: uifnSplitterGestureDriver,
};

// Each installer reads only its own table, so importing one of them bundles only that kind of binding. Overlay,
// menu and navigation-menu wiring works for any definition; the others use the parts of a catalog `name`.

export const overlayDomBinding: SvelteDomBindingInstaller = (context) => (
  context.bridge.definition.name === 'Tour' ? uifnTourOverlayAdapterBinding : uifnOverlayAdapterBinding
)(context);

export const menuDomBinding: SvelteDomBindingInstaller = uifnMenuAdapterBinding;

export const navigationMenuDomBinding: SvelteDomBindingInstaller = uifnNavigationMenuAdapterBinding;

/** A popup without catalog parts toggles and anchors to its `trigger` part. */
export const popupDomBinding: SvelteDomBindingInstaller = (context) => {
  const parts = POPUP[context.bridge.definition.name] ?? { trigger: 'trigger', reference: ['trigger'] };
  createUIFnPopupAdapterBinding(parts as unknown as UIFnAdapterPopupParts)(context);
};

export const rovingFocusDomBinding: SvelteDomBindingInstaller = (context) => {
  const target = ROVING_FOCUS[context.bridge.definition.name];
  if (!target) return;
  createUIFnRovingFocusAdapterBinding(
    typeof target === 'string' ? ROVING_TARGETS[target]! : target as unknown as UIFnAdapterRovingParts,
  )(context);
};

export const rangeGestureDomBinding: SvelteDomBindingInstaller = (context) => {
  const { name } = context.bridge.definition;
  const surfaces = RANGE_GESTURE[name];
  const driver = GESTURE_DRIVERS[name];
  if (surfaces && driver) createUIFnRangeGestureAdapterBinding(driver, surfaces as UIFnAdapterGestureParts)(context);
};

const INSTALLERS: Readonly<Record<SvelteDomBindingKind, SvelteDomBindingInstaller>> = {
  overlayDomBinding,
  menuDomBinding,
  popupDomBinding,
  navigationMenuDomBinding,
  rovingFocusDomBinding,
  rangeGestureDomBinding,
};

/**
 * The installers the generated definition for a catalog primitive lists, in installation order, for a
 * hand-built `SveltePrimitiveDefinition` that reuses a catalog primitive's `name` and `family`. The bridge wires
 * only `definition.domBindings`, so a hand-built definition without them gets no focus trap, roving focus, popup
 * positioning or gesture handling. Each installer looks up the mounted definition's parts by its `name`, so this
 * module bundles every primitive's binding; generated definitions import their @uifn/dom installers directly.
 */
export function svelteDomBindingsFor(target: SvelteDomBindingPlanTarget): readonly SvelteDomBindingInstaller[] {
  return svelteDomBindingSpecs(target).map((spec) => INSTALLERS[spec.installer]);
}
