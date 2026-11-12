import type { UIFnController } from '@uifn/core/controller';
import {
  createUIFnMenuDomBinding,
  createUIFnNavigationMenuDomBinding,
  createUIFnOverlayDomBinding,
  createUIFnPopupDomBinding,
  createUIFnRangeGestureDomBinding,
  createUIFnRovingFocusDomBinding,
  type UIFnDomPlatform,
} from '@uifn/dom';
import type { SveltePrimitiveBridge } from './compound.js';

type AnyRecord = Record<string, unknown>;
type AnyController = UIFnController<AnyRecord, AnyRecord, AnyRecord, AnyRecord>;

export interface SvelteDomBindingContext {
  readonly bridge: SveltePrimitiveBridge<any>;
  readonly controller: AnyController | null;
  readonly platform: UIFnDomPlatform;
  readonly root: HTMLElement;
  /** Registers a created binding; the adapter destroys registered bindings in reverse order. */
  readonly add: (binding: SvelteDomBindingHandle) => void;
}

export interface SvelteDomBindingHandle {
  destroy(): void;
}

/**
 * Wires one kind of @uifn/dom behavior for a mounted primitive. A generated definition lists only the installers
 * its primitive needs (see scripts/uifn-adapter-dom-bindings.mjs), so a one-primitive app bundles only those.
 */
export type SvelteDomBindingInstaller = (context: SvelteDomBindingContext) => void;

const portalManagedExternally = (bridge: SveltePrimitiveBridge<any>) => bridge.getElement('portal') !== null;

export const overlayDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, add }) => {
  const content = bridge.getElement('content');
  if (!content || !controller) return;
  add(createUIFnOverlayDomBinding({
    platform,
    controller: controller as never,
    content,
    trigger: () => {
      if (bridge.definition.name !== 'Tour') return bridge.getElement('trigger');
      const target = (controller.getState().currentStep as { target?: unknown } | undefined)?.target;
      return typeof target === 'string'
        ? content.ownerDocument.querySelector<HTMLElement>(target)
        : null;
    },
    positioner: () => bridge.getElement('positioner'),
    arrow: () => bridge.getElement('arrow'),
    portalNode: bridge.getElement('portal') ?? bridge.getElement('positioner') ?? content,
    portalManagedExternally: portalManagedExternally(bridge),
    validateAccessibleName: true,
  }));
};

export const menuDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, add }) => {
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
    portalManagedExternally: portalManagedExternally(bridge),
    getItemElement: (id) => bridge.getElement('item', id),
  }));
};

const CONTROL_REFERENCE_POPUPS = ['Autocomplete', 'Combobox', 'Select', 'ColorPicker'];

function popupTrigger(bridge: SveltePrimitiveBridge<any>): HTMLElement | null {
  return bridge.definition.name === 'Autocomplete' ? bridge.getElement('input') : bridge.getElement('trigger');
}

function popupReference(bridge: SveltePrimitiveBridge<any>): HTMLElement | null {
  if (CONTROL_REFERENCE_POPUPS.includes(bridge.definition.name)) {
    return bridge.getElement('control') ?? bridge.getElement('input') ?? popupTrigger(bridge);
  }
  if (bridge.definition.name === 'DatePicker') return bridge.getElement('input') ?? popupTrigger(bridge);
  return popupTrigger(bridge);
}

export const popupDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, root, add }) => {
  if (!controller) return;
  const setOpen = controller.actions.setOpen;
  if (!bridge.getElement('content') || !popupTrigger(bridge) || !popupReference(bridge) || typeof setOpen !== 'function') {
    return;
  }
  add(createUIFnPopupDomBinding({
    platform,
    controller: controller as never,
    id: root.id || `${bridge.definition.name.toLowerCase()}-popup`,
    trigger: () => (
      bridge.definition.name === 'Autocomplete'
        ? bridge.getElement('input')
        : bridge.getElement('trigger')
    ),
    reference: () => (
      CONTROL_REFERENCE_POPUPS.includes(bridge.definition.name)
        ? bridge.getElement('control') ?? bridge.getElement('input') ?? bridge.getElement('trigger')
        : bridge.definition.name === 'DatePicker'
          ? bridge.getElement('input') ?? bridge.getElement('trigger')
          : bridge.getElement('trigger')
    ),
    content: () => bridge.getElement('content'),
    positioner: () => bridge.getElement('positioner'),
    portalNode: bridge.getElement('portal') ?? bridge.getElement('positioner'),
    portalManagedExternally: portalManagedExternally(bridge),
    placement: 'bottom-start',
    matchReferenceWidth: ['Autocomplete', 'Combobox', 'Select'].includes(bridge.definition.name),
    getOpen: (state: Record<string, unknown>) => state.open === true,
    setOpen: (next: boolean) => (setOpen as (value: boolean) => void)(next),
  }));
};

export const navigationMenuDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, add }) => {
  if (!controller) return;
  add(createUIFnNavigationMenuDomBinding({
    platform,
    controller: controller as never,
    getTriggerElement: (id) => bridge.getElement('trigger', id),
  }));
};

export const rovingFocusDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, add }) => {
  const roving = rovingTarget(bridge.definition.name, controller?.getState() ?? null);
  if (!controller || !roving) return;
  add(createUIFnRovingFocusDomBinding({
    platform,
    controller,
    getActiveKey: (state) => roving.getActiveKey(state as AnyRecord),
    getElement: (key) => roving.getParts(controller.getState())
      .map((part) => roving.valueScoped ? bridge.getElement(part, key) : bridge.getElement(part))
      .find(Boolean) ?? null,
    // Svelte can register late compound children after the controller is
    // already open. In that case a newly acquired Menubar binding must
    // honor the active item instead of dropping the original focus job.
    focusInitial: bridge.definition.name === 'Menubar' && Boolean(controller.getState().value),
  }));
};

export const rangeGestureDomBinding: SvelteDomBindingInstaller = ({ bridge, controller, platform, add }) => {
  if (!controller) return;
  for (const target of gestureTargets(bridge)) {
    add(createUIFnRangeGestureDomBinding({
      scope: platform.scope,
      primitive: bridge.definition.name as never,
      element: target.element,
      value: target.value,
      controller: controller as never,
    }));
  }
};

function gestureTargets(bridge: SveltePrimitiveBridge<any>): ReadonlyArray<{ value?: unknown; element: HTMLElement }> {
  const name = bridge.definition.name;
  const single = (part: string) => {
    const element = bridge.getElement(part);
    return element ? [{ element }] : [];
  };
  if (name === 'Slider') return single('control');
  if (name === 'AngleSlider') return single('track');
  if (name === 'Carousel') return single('viewport');
  if (name === 'SignaturePad') return single('canvas');
  if (name === 'ImageCropper') return [...single('cropArea'), ...bridge.getElementEntries('handle')];
  if (name === 'ColorPicker') return [...single('area'), ...bridge.getElementEntries('channelSlider')];
  if (name === 'Splitter') return bridge.getElementEntries('resizeHandle').map(({ value, element }) => ({ value: Number(value), element }));
  if (name === 'ScrollArea') return bridge.getElementEntries('thumb');
  return [];
}

interface RovingTarget {
  getActiveKey(state: AnyRecord): string | null;
  getParts(state: AnyRecord): readonly string[];
  readonly valueScoped: boolean;
}

function rovingTarget(name: string, state: AnyRecord | null): RovingTarget | null {
  if (!state) return null;
  if (name === 'Menubar') return {
    getActiveKey: (current) => String(current.value ? current.activeItem ?? '' : current.focusedMenu ?? '') || null,
    getParts: (current) => current.value ? ['item', 'submenuTrigger'] : ['trigger'],
    valueScoped: true,
  };
  const fixed = (stateKey: string, parts: readonly string[]): RovingTarget => ({
    getActiveKey: (current) => String(current[stateKey] ?? '') || null,
    getParts: () => parts,
    valueScoped: true,
  });
  if (name === 'ColorPicker') return {
    getActiveKey: (current) => current.open ? null : 'trigger',
    getParts: () => ['trigger'],
    valueScoped: false,
  };
  if (name === 'Editable') return {
    getActiveKey: (current) => current.editing ? 'input' : 'preview',
    getParts: (current) => current.editing ? ['input'] : ['preview'],
    valueScoped: false,
  };
  if (name === 'PinInput') return {
    getActiveKey: (current) => String(Math.max(0, Number(current.valueLength ?? 0) - (current.completed ? 1 : 0))),
    getParts: () => ['input'],
    valueScoped: true,
  };
  if (name === 'NavigationMenu') return fixed('focusedItem', ['trigger']);
  if (name === 'Tabs') return fixed('focusedItem', ['trigger']);
  if (name === 'Toolbar') return fixed('focusedItem', ['button', 'link']);
  if (name === 'Pagination') return fixed('focusedPage', ['pageTrigger']);
  if (name === 'TreeView') return fixed('focusedItem', ['item']);
  if (['CheckboxGroup', 'Listbox', 'RadioGroup', 'SegmentGroup', 'ToggleGroup'].includes(name)) {
    return fixed('focusedItem', ['itemControl', 'item']);
  }
  return null;
}
