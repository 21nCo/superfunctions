import type { UIFnDomScope } from './scope';
import { trackUIFnPointer, type UIFnPointerTracking } from './pointer';

export interface UIFnGestureBindingOptions {
  readonly element: HTMLElement;
  readonly orientation?: 'horizontal' | 'vertical' | 'both';
  readonly disabled?: () => boolean;
  readonly onStart: (event: PointerEvent) => void;
  readonly onMove: (event: PointerEvent) => void;
  readonly onEnd: (event: PointerEvent) => void;
  readonly onCancel: (event: PointerEvent, reason: 'pointercancel' | 'lostpointercapture' | 'destroy') => void;
}

export interface UIFnGestureBinding {
  readonly activePointerIds: readonly number[];
  cancel(pointerId: number, reason?: 'pointercancel' | 'lostpointercapture' | 'destroy'): void;
  updateOrientation(orientation: 'horizontal' | 'vertical' | 'both'): void;
  destroy(): void;
}

export type UIFnRangeGesturePrimitive =
  | 'Slider'
  | 'AngleSlider'
  | 'Carousel'
  | 'SignaturePad'
  | 'Splitter'
  | 'ImageCropper'
  | 'ColorPicker'
  | 'ScrollArea';

export interface UIFnRangeGestureDomBindingOptions {
  readonly scope: UIFnDomScope;
  readonly primitive: UIFnRangeGesturePrimitive;
  readonly element: HTMLElement;
  readonly value?: unknown;
  readonly controller: {
    readonly actions: Record<string, (...args: any[]) => unknown>;
    getState(): Record<string, any>;
    subscribe?(subscriber: () => void, options?: { readonly emitInitial?: boolean }): () => void;
  };
}

function localPoint(element: HTMLElement, event: PointerEvent): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function axisPercent(element: HTMLElement, event: PointerEvent, orientation: string): number {
  const rect = element.getBoundingClientRect();
  const size = orientation === 'vertical' ? rect.height : rect.width;
  const offset = orientation === 'vertical' ? event.clientY - rect.top : event.clientX - rect.left;
  return Math.max(0, Math.min(100, size > 0 ? offset / size * 100 : 0));
}

function pointerKind(event: PointerEvent): 'mouse' | 'touch' | 'pen' {
  return event.pointerType === 'touch' ? 'touch' : event.pointerType === 'pen' ? 'pen' : 'mouse';
}

export type UIFnRangeGesturePhase = 'start' | 'move' | 'end' | 'cancel';

/** What a range-gesture driver reads for one gesture surface. */
export interface UIFnRangeGestureContext {
  readonly element: HTMLElement;
  /** The surface's part value (an entry value), or undefined for a single-element part. */
  readonly value: unknown;
  readonly actions: Record<string, (...args: any[]) => unknown>;
  getState(): Record<string, any>;
  now(): number;
}

/** Maps one primitive's pointer phases and geometry to its core gesture actions. */
export interface UIFnRangeGestureDriver {
  handle(context: UIFnRangeGestureContext, event: PointerEvent, phase: UIFnRangeGesturePhase, reason?: string): void;
  /** The pan axis the surface owns; defaults to the state's orientation, then the surface value. */
  orientation?(context: UIFnRangeGestureContext): 'horizontal' | 'vertical' | 'both';
}

/** A driver that calls one action per phase with the pointer id and, while dragging, the `args` for the event. */
function phasedGestureDriver(
  names: readonly [start: string, move: string, end: string, cancel: string],
  args: (context: UIFnRangeGestureContext, event: PointerEvent, phase: 'start' | 'move') => readonly unknown[],
): UIFnRangeGestureDriver {
  return {
    handle(context, event, phase, reason) {
      const name = phase === 'start' ? names[0]
        : phase === 'move' ? names[1]
          : phase === 'end' ? names[2]
            : reason === 'lostpointercapture' ? 'lostPointerCapture' : names[3];
      const extra = phase === 'start' || phase === 'move' ? args(context, event, phase) : [];
      context.actions[name]?.(event.pointerId, ...extra);
    },
  };
}

const POINTER_ACTIONS = ['pointerStart', 'pointerMove', 'pointerEnd', 'pointerCancel'] as const;

export const uifnSliderGestureDriver: UIFnRangeGestureDriver = /* @__PURE__ */ phasedGestureDriver(
  POINTER_ACTIONS,
  ({ element, getState }, event, phase) => [
    axisPercent(element, event, getState().orientation),
    phase === 'start' ? pointerKind(event) : localPoint(element, event),
  ],
);

export const uifnAngleSliderGestureDriver: UIFnRangeGestureDriver = /* @__PURE__ */ phasedGestureDriver(
  POINTER_ACTIONS,
  ({ element, getState }, event, phase) => {
    const rect = element.getBoundingClientRect();
    const degrees = (Math.atan2(event.clientY - (rect.top + rect.height / 2), event.clientX - (rect.left + rect.width / 2)) * 180 / Math.PI + 450) % 360;
    const minimum = Number(getState().min ?? 0);
    const maximum = Number(getState().max ?? 360);
    const angle = minimum + degrees / 360 * (maximum - minimum);
    return phase === 'start' ? [angle, pointerKind(event)] : [angle];
  },
);

export const uifnCarouselGestureDriver: UIFnRangeGestureDriver = /* @__PURE__ */ phasedGestureDriver(
  ['dragStart', 'dragMove', 'dragEnd', 'dragCancel'],
  ({ element }, event, phase) => phase === 'start' ? [localPoint(element, event), pointerKind(event)] : [localPoint(element, event)],
);

export const uifnSignaturePadGestureDriver: UIFnRangeGestureDriver = /* @__PURE__ */ phasedGestureDriver(
  POINTER_ACTIONS,
  ({ element, now }, event) => [{ ...localPoint(element, event), pressure: event.pressure, time: now() }],
);

export const uifnSplitterGestureDriver: UIFnRangeGestureDriver = /* @__PURE__ */ phasedGestureDriver(
  ['resizeStart', 'resizeMove', 'resizeEnd', 'resizeCancel'],
  ({ getState, value }, event, phase) => {
    const coordinate = getState().orientation === 'vertical' ? event.clientY : event.clientX;
    return phase === 'start' ? [Number(value ?? 0), coordinate, pointerKind(event)] : [coordinate];
  },
);

export const uifnImageCropperGestureDriver: UIFnRangeGestureDriver = {
  handle({ actions, element, value }, event, phase) {
    if (phase === 'start') {
      if (value === undefined) actions.startDrag?.(localPoint(element, event));
      else actions.startResize?.(value, localPoint(element, event));
    } else if (phase === 'move') actions.move?.(localPoint(element, event));
    else actions.endInteraction?.();
  },
};

export const uifnColorPickerGestureDriver: UIFnRangeGestureDriver = {
  handle({ actions, element, value }, event, phase) {
    if (phase !== 'start' && phase !== 'move') return;
    if (value === undefined) {
      actions.setArea?.(axisPercent(element, event, 'horizontal'), axisPercent(element, event, 'vertical'));
      return;
    }
    const channel = String(value);
    let maximum = 100;
    if (channel === 'alpha') maximum = 1;
    else if (channel === 'h') maximum = 360;
    else if (['r', 'g', 'b'].includes(channel)) maximum = 255;
    actions.setChannel?.(channel, axisPercent(element, event, 'horizontal') / 100 * maximum);
  },
  orientation: ({ value }) => value === undefined ? 'both' : 'horizontal',
};

export const uifnScrollAreaGestureDriver: UIFnRangeGestureDriver = {
  handle({ actions, element, value }, event, phase) {
    if (phase === 'start' || phase === 'move') {
      actions[value === 'horizontal' ? 'dragHorizontalThumb' : 'dragVerticalThumb']?.(axisPercent(element, event, String(value)));
    } else actions.endInteraction?.();
  },
};

const NO_GESTURE: UIFnRangeGestureDriver = { handle() {} };

function defaultOrientation({ getState, value }: UIFnRangeGestureContext): 'horizontal' | 'vertical' | 'both' {
  return getState().orientation ?? (value === 'horizontal' ? 'horizontal' : value === 'vertical' ? 'vertical' : 'both');
}

export interface UIFnRangeGestureDriverBindingOptions extends Omit<UIFnRangeGestureDomBindingOptions, 'primitive'> {
  readonly driver: UIFnRangeGestureDriver;
}

/** Binds pointer capture on one surface to `driver`; framework adapters only supply nodes. */
export function createUIFnRangeGestureDriverBinding(options: UIFnRangeGestureDriverBindingOptions): UIFnGestureBinding {
  const { controller, element, driver } = options;
  const context: UIFnRangeGestureContext = {
    element,
    value: options.value,
    get actions() { return controller.actions; },
    getState: () => controller.getState(),
    now: () => options.scope.environment.now(),
  };
  const orientation = () => (driver.orientation ?? defaultOrientation)(context);
  const binding = createUIFnGestureBinding(options.scope, {
    element,
    orientation: orientation(),
    disabled: () => Boolean(context.getState().disabled || context.getState().readOnly),
    onStart: (event) => driver.handle(context, event, 'start'),
    onMove: (event) => driver.handle(context, event, 'move'),
    onEnd: (event) => driver.handle(context, event, 'end'),
    onCancel: (event, reason) => driver.handle(context, event, 'cancel', reason),
  });
  const unsubscribe = controller.subscribe?.(
    () => binding.updateOrientation(orientation()),
    { emitInitial: false },
  );
  return {
    get activePointerIds() { return binding.activePointerIds; },
    cancel: (pointerId, reason) => binding.cancel(pointerId, reason),
    updateOrientation: (next) => binding.updateOrientation(next),
    destroy() {
      unsubscribe?.();
      binding.destroy();
    },
  };
}

/**
 * Maps pointer capture and geometry to core gesture actions, choosing the driver by `primitive`. This bundles
 * every primitive's driver; adapters call createUIFnRangeGestureDriverBinding with their own driver instead.
 */
export function createUIFnRangeGestureDomBinding(options: UIFnRangeGestureDomBindingOptions): UIFnGestureBinding {
  const drivers: Record<UIFnRangeGesturePrimitive, UIFnRangeGestureDriver> = {
    Slider: uifnSliderGestureDriver,
    AngleSlider: uifnAngleSliderGestureDriver,
    Carousel: uifnCarouselGestureDriver,
    SignaturePad: uifnSignaturePadGestureDriver,
    Splitter: uifnSplitterGestureDriver,
    ImageCropper: uifnImageCropperGestureDriver,
    ColorPicker: uifnColorPickerGestureDriver,
    ScrollArea: uifnScrollAreaGestureDriver,
  };
  return createUIFnRangeGestureDriverBinding({ ...options, driver: drivers[options.primitive] ?? NO_GESTURE });
}

export function createUIFnGestureBinding(scope: UIFnDomScope, options: UIFnGestureBindingOptions): UIFnGestureBinding {
  scope.assertAlive('create gesture binding');
  const trackers = new Map<number, UIFnPointerTracking>();
  const events = new Map<number, PointerEvent>();
  const previousTouchAction = options.element.style.touchAction;
  let destroyed = false;
  const updateOrientation = (orientation: 'horizontal' | 'vertical' | 'both') => {
    if (destroyed) return;
    options.element.style.touchAction = orientation === 'horizontal' ? 'pan-y' : orientation === 'vertical' ? 'pan-x' : 'none';
  };
  updateOrientation(options.orientation ?? 'both');
  const cancel = (pointerId: number, reason: 'pointercancel' | 'lostpointercapture' | 'destroy' = 'pointercancel') => {
    const tracker = trackers.get(pointerId);
    const event = events.get(pointerId);
    if (!tracker || !event) return;
    trackers.delete(pointerId);
    events.delete(pointerId);
    tracker.destroy();
    options.onCancel(event, reason);
  };
  const onPointerDown = (rawEvent: Event) => {
    if (destroyed || options.disabled?.()) return;
    const event = rawEvent as PointerEvent;
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    events.set(event.pointerId, event);
    options.onStart(event);
    const tracker = trackUIFnPointer(scope, event, {
      captureTarget: options.element,
      onMove(moveEvent) { events.set(moveEvent.pointerId, moveEvent); options.onMove(moveEvent); },
      onEnd(endEvent) { trackers.delete(endEvent.pointerId); events.delete(endEvent.pointerId); options.onEnd(endEvent); },
      onCancel(cancelEvent) {
        const reason = cancelEvent.type === 'lostpointercapture' ? 'lostpointercapture' : 'pointercancel';
        trackers.delete(cancelEvent.pointerId); events.delete(cancelEvent.pointerId); options.onCancel(cancelEvent, reason);
      },
    });
    trackers.set(event.pointerId, tracker);
  };
  options.element.addEventListener('pointerdown', onPointerDown);
  const releaseListener = scope.track('listener', () => options.element.removeEventListener('pointerdown', onPointerDown), 'gesture-pointerdown');
  return {
    get activePointerIds() { return Object.freeze([...trackers.keys()]); },
    cancel,
    updateOrientation,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      [...trackers.keys()].forEach((pointerId) => cancel(pointerId, 'destroy'));
      releaseListener();
      options.element.style.touchAction = previousTouchAction;
    },
  };
}
