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
  type UIFnAdapterDomBinding,
} from '@uifn/dom';
import type { SvelteDomBindingInstaller } from './internal/compound.js';
import {
  svelteDomBindingSpecFor,
  svelteDomBindingSpecs,
  type SvelteDomBindingKind,
  type SvelteDomBindingSpec,
} from './internal/dom-binding-plan.js';

export type {
  SvelteDomBindingContext,
  SvelteDomBindingHandle,
  SvelteDomBindingInstaller,
} from './internal/compound.js';

/** The fields of a primitive definition that decide which @uifn/dom bindings it wires. */
export interface SvelteDomBindingPlanTarget {
  readonly name: string;
  readonly family: string;
}

const READY: Readonly<Record<string, UIFnAdapterDomBinding>> = {
  uifnMenuAdapterBinding,
  uifnNavigationMenuAdapterBinding,
  uifnOverlayAdapterBinding,
  uifnTourOverlayAdapterBinding,
};
const FACTORIES: Readonly<Record<string, (descriptor: never) => UIFnAdapterDomBinding>> = {
  createUIFnPopupAdapterBinding,
  createUIFnRangeGestureAdapterBinding,
  createUIFnRovingFocusAdapterBinding,
};
const ROVING_TARGETS: Readonly<Record<string, unknown>> = {
  uifnEditableRovingTarget,
  uifnMenubarRovingTarget,
  uifnPinInputRovingTarget,
  uifnPopupTriggerRovingTarget,
};

function bindingFor(spec: SvelteDomBindingSpec): UIFnAdapterDomBinding {
  if (spec.ready) return READY[spec.ready]!;
  return FACTORIES[spec.factory!]!((spec.target ? ROVING_TARGETS[spec.target] : spec.descriptor) as never);
}

/** Installs one kind of binding for the mounted definition, with the parts its `name` uses in the catalog. */
function installerOf(kind: SvelteDomBindingKind): SvelteDomBindingInstaller {
  return (context) => {
    const spec = svelteDomBindingSpecFor(kind, context.bridge.definition.name);
    if (spec) bindingFor(spec)(context);
  };
}

export const overlayDomBinding: SvelteDomBindingInstaller = installerOf('overlayDomBinding');
export const menuDomBinding: SvelteDomBindingInstaller = installerOf('menuDomBinding');
export const popupDomBinding: SvelteDomBindingInstaller = installerOf('popupDomBinding');
export const navigationMenuDomBinding: SvelteDomBindingInstaller = installerOf('navigationMenuDomBinding');
export const rovingFocusDomBinding: SvelteDomBindingInstaller = installerOf('rovingFocusDomBinding');
export const rangeGestureDomBinding: SvelteDomBindingInstaller = installerOf('rangeGestureDomBinding');

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
