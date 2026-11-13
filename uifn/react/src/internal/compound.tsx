'use client';

import * as React from 'react';
import type { UIFnController, UIFnSnapshot } from '@uifn/core/controller';
import type { UIFnEnvironment } from '@uifn/core/environment';
import {
  mergePartProps,
  resolveUIFnDefaultPartContent,
  type UIFnDefaultPartContent,
  type UIFnPartProps,
} from '@uifn/core/parts';
import type { UIFnStaticPrimitiveContract } from '@uifn/core/primitives';
import {
  acquireUIFnDomPlatform,
  createUIFnNativeFormResetBinding,
  type UIFnAdapterDomBinding,
  type UIFnAdapterDomBindingHandle,
  type UIFnDomResourceSnapshot,
} from '@uifn/dom';
import { toReactPartProps } from '../core-props';
import { Portal } from '../portal';
import { Slot, composeReactRefs } from '../utils/slot';

export const AUTOMATIC_PORTAL_PRIMITIVES: ReadonlySet<string> = new Set(['Select', 'Menu', 'ContextMenu']);
const PositionerOwner = React.createContext<ReactPrimitiveBridge<any> | null>(null);

type AnyRecord = Record<string, unknown>;
type AnyController = UIFnController<AnyRecord, AnyRecord, AnyRecord, AnyRecord>;
type AnyStaticContract = UIFnStaticPrimitiveContract<AnyRecord, AnyRecord, AnyRecord>;
type ElementName = keyof React.JSX.IntrinsicElements;

export interface ReactPrimitiveDefinition<TInputs extends object = AnyRecord> {
  readonly name: string;
  readonly family: string;
  readonly kind: 'interactive-controller' | 'typed-static-contract';
  readonly rootPart: string;
  readonly inputNames: readonly string[];
  readonly context: React.Context<ReactPrimitiveBridge<TInputs> | null>;
  readonly createController?: (inputs: TInputs, environment: UIFnEnvironment) => AnyController;
  readonly contract?: AnyStaticContract;
  /** The @uifn/dom behaviors this primitive wires, in installation order; none when absent. */
  readonly domBindings?: readonly UIFnAdapterDomBinding[];
}

export interface ReactPrimitiveCompositionProps {
  readonly asChild?: boolean;
  readonly render?: React.ReactElement | ((payload: ReactPrimitiveRenderPayload) => React.ReactElement);
  readonly children?: React.ReactNode;
}

export interface ReactPrimitiveRenderPayload {
  readonly props: AnyRecord;
  readonly state: Readonly<AnyRecord>;
  readonly actions: Readonly<AnyRecord>;
  readonly status: string;
  readonly counters: ReactPrimitiveLifecycleCounters;
  readonly bridge: ReactPrimitiveBridge<any>;
}

export interface ReactPrimitiveLifecycleCounters {
  readonly controllerGeneration: number;
  readonly controllerDestroyCount: number;
  readonly activeControllers: number;
  readonly activeDomBindings: number;
  readonly domGeneration: number;
  readonly domDestroyCount: number;
  readonly registeredElements: number;
  readonly subscribers: number;
}

export type ReactPrimitiveRootProps<TInputs extends object, TElement extends ElementName> =
  TInputs
  & Omit<React.ComponentPropsWithoutRef<TElement>, keyof TInputs | 'children'>
  & ReactPrimitiveCompositionProps
  & {
    readonly environment?: UIFnEnvironment;
  };

type PartArgument<TPart> = TPart extends { getProps(value: infer TValue, ...rest: unknown[]): unknown }
  ? TValue
  : TPart extends (value: infer TValue, ...rest: unknown[]) => unknown
    ? TValue
    : unknown;

export type ReactPrimitivePartProps<
  TPart,
  TElement extends ElementName,
  TMany extends boolean,
> = Omit<React.ComponentPropsWithoutRef<TElement>, 'children'>
  & ReactPrimitiveCompositionProps
  & (TMany extends true ? { readonly value: PartArgument<TPart> } : { readonly value?: never })
  & {
    readonly forceMount?: boolean;
    readonly container?: HTMLElement | null;
  };

export interface ReactPrimitiveHookResult<TState = AnyRecord, TActions = AnyRecord> {
  readonly state: Readonly<TState>;
  readonly actions: Readonly<TActions>;
  readonly status: string;
  getPartProps(part: string, value?: unknown, userProps?: AnyRecord): AnyRecord;
}

interface StaticProjection {
  readonly snapshot: Readonly<UIFnSnapshot<AnyRecord>>;
  readonly parts: AnyRecord;
}

const ROOT_DOM_PROP = /^(?:aria-|data-)|^(?:id|class|className|style|title|role|tabindex|tabIndex|hidden|dir|lang|slot|inert|draggable|spellcheck|spellCheck|translate|name|type|value|checked|required|readonly|readOnly|multiple|placeholder|autocomplete|autoComplete|autofocus|autoFocus|inputmode|inputMode|maxlength|maxLength|minlength|minLength|pattern|min|max|step|accept|rows|cols|for|htmlFor|href|target|rel|src|alt|width|height|viewBox|action|method|encType)$/;
const ROOT_EVENT_PROP = /^on(?:Click|DoubleClick|AuxClick|ContextMenu|KeyDown|KeyUp|KeyPress|Focus|Blur|Input|Change|BeforeInput|CompositionStart|CompositionUpdate|CompositionEnd|Copy|Cut|Paste|PointerDown|PointerMove|PointerUp|PointerCancel|PointerEnter|PointerLeave|PointerOver|PointerOut|MouseDown|MouseMove|MouseUp|MouseEnter|MouseLeave|MouseOver|MouseOut|TouchStart|TouchMove|TouchEnd|TouchCancel|Drag|DragStart|DragEnd|DragEnter|DragLeave|DragOver|Drop|Scroll|Wheel|Select|Submit|Reset|Invalid|Load|Error|AnimationStart|AnimationEnd|AnimationIteration|TransitionEnd|Toggle|BeforeToggle|GotPointerCapture|LostPointerCapture)(?:Capture)?$/;

const EMPTY_DOM_RESOURCES: UIFnDomResourceSnapshot = Object.freeze({
  listener: 0,
  observer: 0,
  timer: 0,
  animationFrame: 0,
  layer: 0,
  focusScope: 0,
  modalLock: 0,
  positioner: 0,
  portal: 0,
  presence: 0,
  formBridge: 0,
  liveRegion: 0,
  modality: 0,
  total: 0,
});

function splitRootProps(props: AnyRecord, inputNames: readonly string[] = []): { inputs: AnyRecord; dom: AnyRecord } {
  const inputs: AnyRecord = {};
  const dom: AnyRecord = {};
  const declaredInputs = new Set(inputNames);
  for (const [key, value] of Object.entries(props)) {
    if (declaredInputs.has(key)) inputs[key] = value;
    else if (ROOT_DOM_PROP.test(key) || ROOT_EVENT_PROP.test(key)) dom[key] = value;
    else inputs[key] = value;
  }
  return { inputs, dom };
}

function stableToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'react';
}

function inertScheduler() {
  let nextHandle = 0;
  return {
    now: () => 0,
    setTimeout: () => ++nextHandle,
    clearTimeout: () => undefined,
    setInterval: () => ++nextHandle,
    clearInterval: () => undefined,
    requestAnimationFrame: () => ++nextHandle,
    cancelAnimationFrame: () => undefined,
    queueMicrotask: () => undefined,
  };
}

function inputProxy<TInputs extends object>(latest: { current: TInputs }): TInputs {
  const functions = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy({} as TInputs, {
    get(_target, key) {
      const value = (latest.current as AnyRecord)[key as string];
      if (typeof value !== 'function') return value;
      let delegate = functions.get(key);
      if (!delegate) {
        delegate = (...args: unknown[]) => {
          const current = (latest.current as AnyRecord)[key as string];
          return typeof current === 'function' ? current(...args) : undefined;
        };
        functions.set(key, delegate);
      }
      return delegate;
    },
    has(_target, key) {
      return key in latest.current;
    },
    ownKeys() {
      return Reflect.ownKeys(latest.current);
    },
    getOwnPropertyDescriptor(_target, key) {
      return key in latest.current ? { enumerable: true, configurable: true } : undefined;
    },
  });
}

export class ReactPrimitiveBridge<TInputs extends object = AnyRecord> {
  private readonly listeners = new Set<() => void>();
  private readonly elementListeners = new Set<() => void>();
  private readonly elements = new Map<string, HTMLElement>();
  private readonly latestInputs: { current: TInputs };
  private readonly proxiedInputs: TInputs;
  private current: AnyController | null = null;
  private releaseController: (() => void) | null = null;
  private staticProjection: StaticProjection | null = null;
  private live = false;
  private generation = 0;
  private elementVersion = 0;
  private controllerDestroyCount = 0;
  private activeDomBindings = 0;
  private domGeneration = 0;
  private domDestroyCount = 0;
  private lastDomResources = EMPTY_DOM_RESOURCES;

  constructor(
    readonly definition: ReactPrimitiveDefinition<TInputs>,
    inputs: TInputs,
    private readonly environment: UIFnEnvironment,
  ) {
    this.latestInputs = { current: inputs };
    this.proxiedInputs = inputProxy(this.latestInputs);
    if (definition.kind === 'interactive-controller') this.current = this.create(false);
    else this.projectStatic();
  }

  private scopedEnvironment(live: boolean): UIFnEnvironment {
    const root = () => this.getElement(this.definition.rootPart);
    const token = stableToken(String(this.environment.hydrationSeed ?? this.environment.scopeId ?? this.definition.name));
    return {
      ...this.environment,
      mode: this.environment.mode ?? (live ? 'production' : 'test'),
      scopeId: this.environment.scopeId ?? token,
      hydrationSeed: this.environment.hydrationSeed ?? token,
      root,
      ownerDocument: (candidate) => {
        const element = candidate as HTMLElement | null;
        return element?.ownerDocument ?? null;
      },
      ownerWindow: (document) => (document as Document | null)?.defaultView ?? null,
      generateId: this.environment.generateId ?? ((scope) => `${scope}-${token}`),
      scheduler: live ? this.environment.scheduler : inertScheduler(),
      now: live ? this.environment.now : () => 0,
    };
  }

  private create(live: boolean): AnyController {
    const factory = this.definition.createController;
    if (!factory) throw new TypeError(`${this.definition.name} has no controller factory.`);
    this.generation += 1;
    return factory(this.proxiedInputs, this.scopedEnvironment(live));
  }

  private destroyCurrent(): void {
    if (!this.current) return;
    this.current.destroy();
    this.current = null;
    this.controllerDestroyCount += 1;
  }

  private projectStatic(): void {
    const contract = this.definition.contract;
    if (!contract) throw new TypeError(`${this.definition.name} has no static contract.`);
    const inputs = this.latestInputs.current as AnyRecord;
    const state = contract.getState(inputs);
    this.generation += 1;
    this.staticProjection = {
      snapshot: Object.freeze({ version: this.generation, status: 'idle', state }),
      parts: contract.getParts(inputs, { scopeId: String(this.environment.scopeId ?? this.environment.hydrationSeed ?? this.definition.name) }),
    };
  }

  private activate(): void {
    if (this.definition.kind !== 'interactive-controller' || this.live) return;
    this.releaseController?.();
    this.releaseController = null;
    this.destroyCurrent();
    this.current = this.create(true);
    this.releaseController = this.current.subscribe(() => this.emit());
    this.live = true;
  }

  private deactivate(): void {
    if (this.definition.kind !== 'interactive-controller' || !this.live) return;
    this.releaseController?.();
    this.releaseController = null;
    this.destroyCurrent();
    this.live = false;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.activate();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.deactivate();
    };
  };

  readonly subscribeElements = (listener: () => void): (() => void) => {
    this.elementListeners.add(listener);
    return () => this.elementListeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  readonly getSnapshot = (): Readonly<UIFnSnapshot<AnyRecord>> => {
    if (this.current) return this.current.getSnapshot();
    if (this.staticProjection) return this.staticProjection.snapshot;
    if (this.definition.kind === 'interactive-controller') {
      this.current = this.create(false);
      return this.current.getSnapshot();
    }
    throw new TypeError(`${this.definition.name} has no current projection.`);
  };

  readonly getServerSnapshot = (): Readonly<UIFnSnapshot<AnyRecord>> => this.getSnapshot();
  readonly getElementVersion = (): number => this.elementVersion;
  getGeneration(): number { return this.generation; }
  getController(): AnyController | null { return this.current; }
  getActions(): AnyRecord { return this.current?.actions ?? {}; }
  getStatus(): string { return this.current?.status ?? this.staticProjection?.snapshot.status ?? 'idle'; }
  getLifecycleCounters(): ReactPrimitiveLifecycleCounters {
    return Object.freeze({
      controllerGeneration: this.generation,
      controllerDestroyCount: this.controllerDestroyCount,
      activeControllers: this.current ? 1 : 0,
      activeDomBindings: this.activeDomBindings,
      domGeneration: this.domGeneration,
      domDestroyCount: this.domDestroyCount,
      registeredElements: this.elements.size,
      subscribers: this.listeners.size,
    });
  }

  getDomResources(): Readonly<UIFnDomResourceSnapshot> {
    return this.lastDomResources;
  }

  recordDomBindingAcquire(): void {
    this.activeDomBindings += 1;
    this.domGeneration += 1;
  }

  recordDomBindingRelease(resources: Readonly<UIFnDomResourceSnapshot>): void {
    if (this.activeDomBindings === 0) return;
    this.activeDomBindings -= 1;
    this.domDestroyCount += 1;
    this.lastDomResources = Object.freeze({ ...resources });
  }

  update(inputs: TInputs): void {
    const previous = this.latestInputs.current as AnyRecord;
    const next = inputs as AnyRecord;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const changedKeys = [...keys].filter((key) => {
      if (typeof previous[key] === 'function' || typeof next[key] === 'function') return false;
      return !equalInput(previous[key], next[key]);
    });
    this.latestInputs.current = inputs;
    if (changedKeys.length === 0) return;
    if (this.definition.kind === 'typed-static-contract') {
      this.projectStatic();
      this.emit();
      return;
    }
    this.current?.update(Object.fromEntries(changedKeys.map((key) => [key, next[key]])) as Partial<AnyRecord>);
  }

  getPartProps(part: string, value: unknown, userProps: AnyRecord): UIFnPartProps {
    if (this.staticProjection) {
      const projected = this.staticProjection.parts[part];
      const generated = typeof projected === 'function' ? projected(value) : projected;
      if (!generated) throw new TypeError(`${this.definition.name}.${part} is absent from the public static contract.`);
      return mergePartProps(generated as UIFnPartProps, userProps);
    }
    const controllerPart = this.current?.parts[part] as { getProps(...args: unknown[]): UIFnPartProps } | undefined;
    if (!controllerPart) throw new TypeError(`${this.definition.name}.${part} is absent from the public core controller.`);
    return value === undefined ? controllerPart.getProps(userProps) : controllerPart.getProps(value, userProps);
  }

  registerElement(part: string, value: unknown, element: HTMLElement | null): void {
    const key = `${part}:${value === undefined ? '' : String(value)}`;
    const previous = this.elements.get(key) ?? null;
    if (previous === element) return;
    if (element) this.elements.set(key, element);
    else this.elements.delete(key);
    this.elementVersion += 1;
    this.elementListeners.forEach((listener) => listener());
  }

  getElement(part: string, value?: unknown): HTMLElement | null {
    return this.elements.get(`${part}:${value === undefined ? '' : String(value)}`) ?? null;
  }

  getElementEntries(part: string): ReadonlyArray<{ value: string; element: HTMLElement }> {
    const prefix = `${part}:`;
    return [...this.elements.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, element]) => ({ value: key.slice(prefix.length), element }));
  }
}

function equalInput(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 3 || !left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalInput(value, right[index], depth + 1));
  }
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftPrototype !== Object.prototype || rightPrototype !== Object.prototype) return false;
  const leftRecord = left as AnyRecord;
  const rightRecord = right as AnyRecord;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => equalInput(leftRecord[key], rightRecord[key], depth + 1));
}

function useBridge<TInputs extends object>(
  definition: ReactPrimitiveDefinition<TInputs>,
  inputs: TInputs,
  environment: UIFnEnvironment | undefined,
): ReactPrimitiveBridge<TInputs> {
  const reactId = React.useId();
  const bridgeRef = React.useRef<ReactPrimitiveBridge<TInputs> | null>(null);
  if (!bridgeRef.current) {
    bridgeRef.current = new ReactPrimitiveBridge(definition, inputs, {
      ...environment,
      scopeId: environment?.scopeId ?? `${definition.name}-${stableToken(reactId)}`,
      hydrationSeed: environment?.hydrationSeed ?? stableToken(reactId),
    });
  }
  const bridge = bridgeRef.current;
  React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getServerSnapshot);
  React.useEffect(() => bridge.update(inputs), [bridge, inputs]);
  return bridge;
}

function useDomOwnership<TInputs extends object>(bridge: ReactPrimitiveBridge<TInputs>): void {
  const elementVersion = React.useSyncExternalStore(
    bridge.subscribeElements,
    bridge.getElementVersion,
    () => 0,
  );
  const generation = bridge.getGeneration();
  React.useEffect(() => {
    const root = bridge.getElement(bridge.definition.rootPart);
    if (!root) return undefined;
    const lease = acquireUIFnDomPlatform({ root: root.ownerDocument });
    const bindings: UIFnAdapterDomBindingHandle[] = [];
    const controller = bridge.getController();
    const reset = controller?.actions.reset;
    if (typeof reset === 'function') {
      bindings.push(createUIFnNativeFormResetBinding(lease.platform.scope, root, () => reset()));
    }
    const portalManagedExternally = bridge.getElement('portal') !== null || AUTOMATIC_PORTAL_PRIMITIVES.has(bridge.definition.name);
    for (const install of bridge.definition.domBindings ?? []) {
      install({ bridge, controller, platform: lease.platform, root, portalManagedExternally, add: (binding) => bindings.push(binding) });
    }
    bridge.recordDomBindingAcquire();
    return () => {
      bindings.reverse().forEach((binding) => binding.destroy());
      lease.release();
      bridge.recordDomBindingRelease(lease.platform.scope.resources());
    };
  }, [bridge, elementVersion, generation]);
}

function renderComposed(
  element: ElementName,
  props: AnyRecord,
  composition: ReactPrimitiveCompositionProps,
  payload: Omit<ReactPrimitiveRenderPayload, 'props'>,
): React.ReactElement {
  const { asChild, render, children } = composition;
  if (typeof render === 'function') return render({ ...payload, props: { ...props, children } });
  if (React.isValidElement(render)) {
    return (
      <Slot {...props}>
        {React.cloneElement(render as React.ReactElement<AnyRecord>, children === undefined ? {} : { children })}
      </Slot>
    );
  }
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return React.createElement(element, props, children);
}

function renderReactDefaultPartContent(content: UIFnDefaultPartContent | undefined): React.ReactNode {
  if (content && typeof content === 'object' && content.kind === 'svg-path') {
    return <path d={content.d} fill="currentColor" />;
  }
  return typeof content === 'string' ? content : undefined;
}

export interface ReactPrimitiveRootRuntimeProps<TInputs extends object> {
  readonly definition: ReactPrimitiveDefinition<TInputs>;
  readonly element: ElementName;
  readonly forwardedRef: React.ForwardedRef<HTMLElement>;
  readonly props: ReactPrimitiveRootProps<TInputs, ElementName>;
}

export function ReactPrimitiveRoot<TInputs extends object>({
  definition,
  element,
  forwardedRef,
  props,
}: ReactPrimitiveRootRuntimeProps<TInputs>): React.ReactElement {
  const { asChild, render, children, environment, ...rest } = props as ReactPrimitiveRootProps<TInputs, ElementName> & AnyRecord;
  const inputNames = definition.name === 'AngleSlider'
    ? [...definition.inputNames, 'name']
    : definition.inputNames;
  const split = splitRootProps(rest, inputNames);
  const bridge = useBridge(definition, split.inputs as TInputs, environment);
  useDomOwnership(bridge);
  const coreProps = bridge.getPartProps(definition.rootPart, undefined, split.dom);
  const coreRef = coreProps.ref;
  delete coreProps.ref;
  const latestRefs = React.useRef([forwardedRef, coreRef] as React.Ref<HTMLElement>[]);
  latestRefs.current = [forwardedRef, coreRef as React.Ref<HTMLElement>];
  const ref = React.useCallback((node: HTMLElement | null) => {
    composeReactRefs(...latestRefs.current)(node);
    bridge.registerElement(definition.rootPart, undefined, node);
  }, [bridge, definition.rootPart]);
  const reactProps = toReactPartProps(coreProps, { ...split.dom, ref }) as AnyRecord;
  return (
    <definition.context.Provider value={bridge}>
      {renderComposed(element, reactProps, { asChild, render, children }, {
        state: bridge.getSnapshot().state,
        actions: bridge.getActions(),
        status: bridge.getStatus(),
        counters: bridge.getLifecycleCounters(),
        bridge,
      })}
    </definition.context.Provider>
  );
}

export interface ReactPrimitivePartRuntimeProps {
  readonly definition: ReactPrimitiveDefinition;
  readonly part: string;
  readonly element: ElementName;
  readonly many: boolean;
  readonly forwardedRef: React.ForwardedRef<HTMLElement>;
  readonly props: ReactPrimitivePartProps<unknown, ElementName, boolean>;
}

export function ReactPrimitivePart({
  definition,
  part,
  element,
  many,
  forwardedRef,
  props,
}: ReactPrimitivePartRuntimeProps): React.ReactElement | null {
  const bridge = React.useContext(definition.context);
  const positionerOwner = React.useContext(PositionerOwner);
  if (!bridge) throw new TypeError(`${definition.name}.${part} MUST be rendered inside ${definition.name}.Root.`);
  React.useSyncExternalStore(bridge.subscribeElements, bridge.getElementVersion, () => 0);
  React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getServerSnapshot);
  const { asChild, render, children, value, forceMount, container, ...userProps } = props as ReactPrimitivePartProps<unknown, ElementName, boolean> & AnyRecord;
  if (many && value === undefined) {
    throw new TypeError(`${definition.name}.${part} requires a value prop.`);
  }
  const coreProps = bridge.getPartProps(part, many ? value : undefined, userProps);
  if (forceMount) delete coreProps.hidden;
  const coreRef = coreProps.ref;
  delete coreProps.ref;
  const latestRefs = React.useRef([forwardedRef, coreRef] as React.Ref<HTMLElement>[]);
  latestRefs.current = [forwardedRef, coreRef as React.Ref<HTMLElement>];
  const ref = React.useCallback((node: HTMLElement | null) => {
    composeReactRefs(...latestRefs.current)(node);
    bridge.registerElement(part, many ? value : undefined, node);
  }, [bridge, many, part, value]);
  const reactProps = toReactPartProps(coreProps, { ...userProps, ref }) as AnyRecord;
  if (part === 'portal') reactProps['data-uifn-portal-id'] = coreProps.id;
  const defaultChildren = children ?? renderReactDefaultPartContent(
    resolveUIFnDefaultPartContent(
      definition.name,
      part,
      bridge.getSnapshot().state,
    ),
  );
  const rendered = renderComposed(element, reactProps, { asChild, render, children: defaultChildren }, {
    state: bridge.getSnapshot().state,
    actions: bridge.getActions(),
    status: bridge.getStatus(),
    counters: bridge.getLifecycleCounters(),
    bridge,
  });
  // These compounds have no Portal part. React must own their popup portal so
  // delegated events continue to reach the root after the popup opens.
  if (AUTOMATIC_PORTAL_PRIMITIVES.has(definition.name) && part === 'content' && positionerOwner === bridge && container != null) {
    throw new Error('Pass container to Positioner when Content is nested inside Positioner.');
  }
  const automaticPortal = AUTOMATIC_PORTAL_PRIMITIVES.has(definition.name) &&
    (part === 'positioner' || (part === 'content' && positionerOwner !== bridge));
  const subtree = part === 'positioner' ? <PositionerOwner.Provider value={bridge}>{rendered}</PositionerOwner.Provider> : rendered;
  if (part === 'portal' || automaticPortal) {
    const ownerDocument = bridge.getElement(definition.rootPart)?.ownerDocument;
    const ownerBody = ownerDocument?.body ?? ownerDocument?.documentElement;
    if (container == null && !ownerBody) return null;
    return <Portal container={container ?? ownerBody}>{subtree}</Portal>;
  }
  return subtree;
}

export function useReactPrimitive<TInputs extends object>(
  definition: ReactPrimitiveDefinition<TInputs>,
  inputs: TInputs,
  environment?: UIFnEnvironment,
): ReactPrimitiveHookResult {
  const bridge = useBridge(definition, inputs, environment);
  return React.useMemo(() => ({
    state: bridge.getSnapshot().state,
    actions: bridge.getActions(),
    status: bridge.getStatus(),
    getPartProps: (part: string, value?: unknown, userProps: AnyRecord = {}) =>
      toReactPartProps(bridge.getPartProps(part, value, userProps), userProps),
  }), [bridge, bridge.getSnapshot()]);
}
