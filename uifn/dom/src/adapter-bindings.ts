import type { UIFnController } from '@uifn/core/controller';
import { createUIFnRangeGestureDomBinding } from './gesture';
import {
  createUIFnMenuDomBinding,
  createUIFnNavigationMenuDomBinding,
  createUIFnRovingFocusDomBinding,
} from './navigation';
import { createUIFnOverlayDomBinding } from './overlay';
import type { UIFnDomPlatform } from './platform';
import { createUIFnPopupDomBinding } from './popup';

// The DOM wiring the headless adapters (@uifn/react, @uifn/svelte, @uifn/solid) install for a mounted primitive.
// Each generated definition lists the installers its primitive needs, with that primitive's parts and state keys
// as arguments, so an installer never branches on a primitive name and a one-primitive app bundles only the
// installers and descriptors it uses.

type AnyRecord = Record<string, unknown>;

/** The part of an adapter's primitive bridge that the installers read. */
export interface UIFnAdapterDomBridge {
  readonly definition: { readonly name: string };
  getElement(part: string, value?: unknown): HTMLElement | null;
  getElementEntries(part: string): ReadonlyArray<{ value: string; element: HTMLElement }>;
}

export interface UIFnAdapterDomBindingHandle {
  destroy(): void;
}

export interface UIFnAdapterDomBindingContext<TBridge extends UIFnAdapterDomBridge = UIFnAdapterDomBridge> {
  readonly bridge: TBridge;
  readonly controller: UIFnController<AnyRecord, AnyRecord, AnyRecord, AnyRecord> | null;
  readonly platform: UIFnDomPlatform;
  readonly root: HTMLElement;
  /** True when the adapter, or a registered portal part, owns where the floating content is mounted. */
  readonly portalManagedExternally: boolean;
  /** True when the adapter can register compound children after the controller became active (Svelte). */
  readonly lateChildRegistration?: boolean;
  /** Registers a created binding; the adapter destroys registered bindings in reverse order. */
  readonly add: (binding: UIFnAdapterDomBindingHandle) => void;
}

/** Wires one kind of @uifn/dom behavior for a mounted primitive. */
export type UIFnAdapterDomBinding = (context: UIFnAdapterDomBindingContext) => void;

function firstElement(bridge: UIFnAdapterDomBridge, parts: readonly string[]): HTMLElement | null {
  for (const part of parts) {
    const element = bridge.getElement(part);
    if (element) return element;
  }
  return null;
}

type OverlayTrigger = (context: UIFnAdapterDomBindingContext, content: HTMLElement) => HTMLElement | null;

function overlayBinding(trigger: OverlayTrigger): UIFnAdapterDomBinding {
  return (context) => {
    const { bridge, controller, platform, add } = context;
    const content = bridge.getElement('content');
    if (!content || !controller) return;
    add(createUIFnOverlayDomBinding({
      platform,
      controller: controller as never,
      content,
      trigger: () => trigger(context, content),
      positioner: () => bridge.getElement('positioner'),
      arrow: () => bridge.getElement('arrow'),
      portalNode: bridge.getElement('portal') ?? bridge.getElement('positioner') ?? content,
      portalManagedExternally: context.portalManagedExternally,
      validateAccessibleName: true,
    }));
  };
}

/** Modal and non-modal overlays whose focus returns to the `trigger` part. */
export const uifnOverlayAdapterBinding: UIFnAdapterDomBinding = /* @__PURE__ */ overlayBinding(
  ({ bridge }) => bridge.getElement('trigger'),
);

/** An overlay anchored to the element the current tour step targets by selector. */
export const uifnTourOverlayAdapterBinding: UIFnAdapterDomBinding = /* @__PURE__ */ overlayBinding(
  ({ controller }, content) => {
    const target = (controller?.getState().currentStep as { target?: unknown } | undefined)?.target;
    return typeof target === 'string' ? content.ownerDocument.querySelector<HTMLElement>(target) : null;
  },
);

export const uifnMenuAdapterBinding: UIFnAdapterDomBinding = ({ bridge, controller, platform, add, portalManagedExternally }) => {
  const trigger = bridge.getElement('trigger');
  const content = bridge.getElement('content');
  if (!controller || !trigger || !content) return;
  add(createUIFnMenuDomBinding({
    platform,
    controller: controller as never,
    id: content.id,
    trigger,
    content,
    positioner: () => bridge.getElement('positioner'),
    portalManagedExternally,
    getItemElement: (id) => bridge.getElement('item', id),
  }));
};

export const uifnNavigationMenuAdapterBinding: UIFnAdapterDomBinding = ({ bridge, controller, platform, add }) => {
  if (!controller) return;
  add(createUIFnNavigationMenuDomBinding({
    platform,
    controller: controller as never,
    getTriggerElement: (id) => bridge.getElement('trigger', id),
  }));
};

export interface UIFnAdapterPopupParts {
  /** The part that opens and closes the popup. */
  readonly trigger: string;
  /** The parts the popup is positioned against; the first registered one wins. */
  readonly reference: readonly string[];
  /** Size the popup to the reference element's width. */
  readonly matchReferenceWidth?: boolean;
}

export function createUIFnPopupAdapterBinding(parts: UIFnAdapterPopupParts): UIFnAdapterDomBinding {
  return ({ bridge, controller, platform, root, add, portalManagedExternally }) => {
    if (!controller) return;
    const setOpen = controller.actions.setOpen;
    const trigger = () => bridge.getElement(parts.trigger);
    const reference = () => firstElement(bridge, parts.reference);
    if (!bridge.getElement('content') || !trigger() || !reference() || typeof setOpen !== 'function') return;
    add(createUIFnPopupDomBinding({
      platform,
      controller: controller as never,
      id: root.id || `${bridge.definition.name.toLowerCase()}-popup`,
      trigger,
      reference,
      content: () => bridge.getElement('content'),
      positioner: () => bridge.getElement('positioner'),
      portalNode: bridge.getElement('portal') ?? bridge.getElement('positioner'),
      portalManagedExternally,
      placement: 'bottom-start',
      matchReferenceWidth: parts.matchReferenceWidth === true,
      getOpen: (state: AnyRecord) => state.open === true,
      setOpen: (next: boolean) => (setOpen as (value: boolean) => void)(next),
    }));
  };
}

/** A roving-focus target whose active key is one state field and whose elements are value-scoped parts. */
export interface UIFnAdapterRovingParts {
  readonly stateKey: string;
  readonly parts: readonly string[];
}

/** A roving-focus target whose active key or parts depend on more than one state field. */
export interface UIFnAdapterRovingTarget {
  getActiveKey(state: AnyRecord): string | null;
  getParts(state: AnyRecord): readonly string[];
  /** Look elements up by part and active key (true) or by part alone (false). */
  readonly valueScoped: boolean;
  /** Whether a binding created while the primitive is already active moves focus to the active element. */
  focusOnLateRegistration?(state: AnyRecord): boolean;
}

function rovingTarget(target: UIFnAdapterRovingParts | UIFnAdapterRovingTarget): UIFnAdapterRovingTarget {
  if ('getActiveKey' in target) return target;
  return {
    getActiveKey: (state) => String(state[target.stateKey] ?? '') || null,
    getParts: () => target.parts,
    valueScoped: true,
  };
}

export function createUIFnRovingFocusAdapterBinding(
  target: UIFnAdapterRovingParts | UIFnAdapterRovingTarget,
): UIFnAdapterDomBinding {
  const roving = rovingTarget(target);
  return ({ bridge, controller, platform, add, lateChildRegistration }) => {
    if (!controller) return;
    add(createUIFnRovingFocusDomBinding({
      platform,
      controller,
      getActiveKey: (state) => roving.getActiveKey(state as AnyRecord),
      getElement: (key) => roving.getParts(controller.getState())
        .map((part) => roving.valueScoped ? bridge.getElement(part, key) : bridge.getElement(part))
        .find(Boolean) ?? null,
      // A late-registered child of an already open primitive keeps the focus job its first binding started.
      focusInitial: lateChildRegistration === true && roving.focusOnLateRegistration?.(controller.getState()) === true,
    }));
  };
}

export const uifnMenubarRovingTarget: UIFnAdapterRovingTarget = {
  getActiveKey: (state) => String(state.value ? state.activeItem ?? '' : state.focusedMenu ?? '') || null,
  getParts: (state) => state.value ? ['item', 'submenuTrigger'] : ['trigger'],
  valueScoped: true,
  focusOnLateRegistration: (state) => Boolean(state.value),
};

export const uifnEditableRovingTarget: UIFnAdapterRovingTarget = {
  getActiveKey: (state) => state.editing ? 'input' : 'preview',
  getParts: (state) => state.editing ? ['input'] : ['preview'],
  valueScoped: false,
};

export const uifnPinInputRovingTarget: UIFnAdapterRovingTarget = {
  getActiveKey: (state) => String(Math.max(0, Number(state.valueLength ?? 0) - (state.completed ? 1 : 0))),
  getParts: () => ['input'],
  valueScoped: true,
};

/** Keeps the closed trigger focusable; the open popup owns focus. */
export const uifnPopupTriggerRovingTarget: UIFnAdapterRovingTarget = {
  getActiveKey: (state) => state.open ? null : 'trigger',
  getParts: () => ['trigger'],
  valueScoped: false,
};

export interface UIFnAdapterGestureParts {
  /** Parts that are each one gesture surface. */
  readonly parts?: readonly string[];
  /** Many-parts whose registered elements are each a gesture surface for their value. */
  readonly entries?: readonly string[];
  /** Pass entry values to the gesture as numbers. */
  readonly numericEntryValues?: boolean;
}

export function createUIFnRangeGestureAdapterBinding(surfaces: UIFnAdapterGestureParts): UIFnAdapterDomBinding {
  return ({ bridge, controller, platform, add }) => {
    if (!controller) return;
    const targets: Array<{ value?: unknown; element: HTMLElement }> = [];
    for (const part of surfaces.parts ?? []) {
      const element = bridge.getElement(part);
      if (element) targets.push({ element });
    }
    for (const part of surfaces.entries ?? []) {
      for (const { value, element } of bridge.getElementEntries(part)) {
        targets.push({ element, value: surfaces.numericEntryValues ? Number(value) : value });
      }
    }
    for (const target of targets) {
      add(createUIFnRangeGestureDomBinding({
        scope: platform.scope,
        primitive: bridge.definition.name as never,
        element: target.element,
        value: target.value,
        controller: controller as never,
      }));
    }
  };
}
