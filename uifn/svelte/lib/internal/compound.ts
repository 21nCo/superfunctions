import type { UIFnController, UIFnSnapshot } from '@uifn/core/controller';
import type { UIFnEnvironment } from '@uifn/core/environment';
import { mergePartProps, type UIFnPartProps } from '@uifn/core/parts';
import type { UIFnStaticPrimitiveContract } from '@uifn/core/primitives';
import {
  acquireUIFnDomPlatform,
  createUIFnNativeFormResetBinding,
  createUIFnPortal,
  type UIFnAdapterDomBindingContext,
  type UIFnAdapterDomBindingHandle,
  type UIFnDomResourceSnapshot,
  type UIFnPortalTarget,
} from '@uifn/dom';
import type { Snippet } from 'svelte';
import type { SvelteHTMLElements } from 'svelte/elements';

export type AnyRecord = Record<string, unknown>;
type AnyController = UIFnController<AnyRecord, AnyRecord, AnyRecord, AnyRecord>;
type AnyStaticContract = UIFnStaticPrimitiveContract<AnyRecord, AnyRecord, AnyRecord>;
export type SvelteElementName = Extract<keyof SvelteHTMLElements, string>;

/** What a DOM binding installer receives when the bridge mounts: the bridge, its controller and DOM platform. */
export type SvelteDomBindingContext = UIFnAdapterDomBindingContext<SveltePrimitiveBridge<any>>;
export type SvelteDomBindingHandle = UIFnAdapterDomBindingHandle;
/** Wires one kind of @uifn/dom behavior for a mounted primitive; the @uifn/dom adapter installers fit here. */
export type SvelteDomBindingInstaller = (context: SvelteDomBindingContext) => void;

/** Focus work a primitive must run after Svelte commits controller-driven attributes to the DOM. */
export interface SvelteCommitFocusHandle {
  /** The live controller's state changed; Svelte has not yet committed the matching action parameters. */
  changed(): void;
  /** A DOM commit for the live controller has landed. */
  committed(): void;
  destroy(): void;
}

/** Created for each live controller of a definition that lists it. */
export type SvelteCommitFocus = (bridge: SveltePrimitiveBridge<any>, controller: AnyController) => SvelteCommitFocusHandle;

export interface SveltePrimitiveDefinition<TInputs extends object = AnyRecord> {
  readonly name: string;
  readonly family: string;
  readonly kind: 'interactive-controller' | 'typed-static-contract';
  readonly rootPart: string;
  readonly inputNames: readonly string[];
  readonly contextKey: symbol;
  readonly createController?: (inputs: TInputs, environment: UIFnEnvironment) => AnyController;
  readonly contract?: AnyStaticContract;
  /** The @uifn/dom behaviors this primitive wires, in installation order; none when absent. */
  readonly domBindings?: readonly SvelteDomBindingInstaller[];
  /** Focus work that waits for Svelte's DOM commit; none when absent. */
  readonly commitFocus?: SvelteCommitFocus;
}

export interface SveltePrimitiveRenderPayload {
  readonly props: Record<string, unknown>;
  readonly action: (node: HTMLElement, params?: UIFnPartProps) => {
    update(next?: UIFnPartProps): void;
    destroy(): void;
  };
  readonly actionParams: UIFnPartProps;
  readonly state: Readonly<AnyRecord>;
  readonly actions: Readonly<AnyRecord>;
  readonly status: string;
  readonly bridge: SveltePrimitiveBridge;
}

export interface SveltePrimitiveCompositionProps {
  readonly children?: Snippet;
  readonly render?: Snippet<[SveltePrimitiveRenderPayload]>;
  readonly ref?: HTMLElement | SVGElement | null;
}

export type SveltePrimitiveRootProps<
  TInputs extends object,
  TElement extends SvelteElementName,
> = TInputs
  & Omit<SvelteHTMLElements[TElement], keyof TInputs | 'children'>
  & SveltePrimitiveCompositionProps
  & { readonly environment?: UIFnEnvironment };

type PartArgument<TPart> = TPart extends { getProps(value: infer TValue, ...rest: unknown[]): unknown }
  ? TValue
  : TPart extends (value: infer TValue, ...rest: unknown[]) => unknown
    ? TValue
    : unknown;

export type SveltePrimitivePartProps<
  TPart,
  TElement extends SvelteElementName,
  TMany extends boolean,
> = Omit<SvelteHTMLElements[TElement], 'children'>
  & SveltePrimitiveCompositionProps
  & (TMany extends true ? { readonly value: PartArgument<TPart> } : { readonly value?: never })
  & {
    readonly forceMount?: boolean;
    readonly container?: UIFnPortalTarget;
  };

interface StaticProjection {
  readonly snapshot: Readonly<UIFnSnapshot<AnyRecord>>;
  readonly parts: AnyRecord;
}

interface RegisteredElement {
  readonly element: HTMLElement;
  readonly portalTarget?: UIFnPortalTarget;
}

interface SvelteDomBinding {
  update?: (...args: any[]) => void;
  destroy(): void;
}

const ROOT_DOM_PROP = /^(?:aria-|data-)|^(?:id|class|className|style|title|role|tabindex|tabIndex|hidden|dir|lang|slot|inert|draggable|spellcheck|spellCheck|translate|name|type|value|checked|required|readonly|readOnly|multiple|placeholder|autocomplete|autofocus|min|max|step|accept|rows|cols|for|href|target|rel|src|alt|width|height|viewBox|action|method|enctype|encType)$/;
const ROOT_EVENT_PROP = /^on(?::)?[a-z]/;

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

export function splitSvelteRootProps(props: AnyRecord, inputNames: readonly string[] = []): {
  inputs: AnyRecord;
  dom: AnyRecord;
  environment?: UIFnEnvironment;
} {
  const inputs: AnyRecord = {};
  const dom: AnyRecord = {};
  let environment: UIFnEnvironment | undefined;
  const declaredInputs = new Set(inputNames);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'environment') environment = value as UIFnEnvironment | undefined;
    else if (declaredInputs.has(key) || /^on[A-Z]/.test(key)) inputs[key] = value;
    else if (ROOT_DOM_PROP.test(key) || ROOT_EVENT_PROP.test(key)) dom[key] = value;
    else inputs[key] = value;
  }
  return { inputs, dom, environment };
}

function stableToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'svelte';
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

function equalInput(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 3 || !left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalInput(value, right[index], depth + 1));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const leftRecord = left as AnyRecord;
  const rightRecord = right as AnyRecord;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => equalInput(leftRecord[key], rightRecord[key], depth + 1));
}

function inputChanged(key: string, previous: unknown, next: unknown): boolean {
  if (typeof previous === 'function' || typeof next === 'function') {
    return !/^on[A-Z]/.test(key) && !Object.is(previous, next);
  }
  return !equalInput(previous, next);
}

export class SveltePrimitiveBridge<TInputs extends object = AnyRecord> {
  private readonly listeners = new Set<() => void>();
  private readonly elements = new Map<string, RegisteredElement>();
  private readonly latestInputs: { current: TInputs };
  private readonly proxiedInputs: TInputs;
  private current: AnyController | null = null;
  private releaseController: (() => void) | null = null;
  private releaseDom: (() => void) | null = null;
  private staticProjection: StaticProjection | null = null;
  private live = false;
  private destroyed = false;
  private generation = 0;
  private controllerDestroyCount = 0;
  private domGeneration = 0;
  private domDestroyCount = 0;
  private lastDomResources = EMPTY_DOM_RESOURCES;
  private domRefreshQueued = false;
  private domRefreshEpoch = 0;
  private domCommitQueued = false;
  private domBindings: readonly SvelteDomBinding[] = [];
  private commitFocus: SvelteCommitFocusHandle | null = null;

  constructor(
    readonly definition: SveltePrimitiveDefinition<TInputs>,
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
      ownerDocument: (candidate) => (candidate as HTMLElement | null)?.ownerDocument ?? null,
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
      parts: contract.getParts(inputs, {
        scopeId: String(this.environment.scopeId ?? this.environment.hydrationSeed ?? this.definition.name),
      }),
    };
  }

  private activate(): void {
    if (this.definition.kind !== 'interactive-controller' || this.live || this.destroyed) return;
    this.releaseController?.();
    this.releaseController = null;
    this.destroyCurrent();
    this.current = this.create(true);
    this.releaseCommitFocus();
    this.commitFocus = this.definition.commitFocus?.(this, this.current) ?? null;
    this.releaseController = this.current.subscribe(() => {
      this.emit();
      this.commitFocus?.changed();
    }, { emitInitial: false });
    this.live = true;
    this.refreshDomOwnership();
  }

  /**
   * Promote the deterministic pre-DOM projection to the live browser
   * controller before compound children read their first part props.
   *
   * Svelte initializes child actions before root effects run. Waiting for the
   * first subscription would therefore let children retain handlers and refs
   * from the destroyed pre-DOM controller during hydration.
   */
  connect(): void {
    this.activate();
  }

  private deactivate(): void {
    if (this.definition.kind !== 'interactive-controller' || !this.live) return;
    this.releaseDom?.();
    this.releaseDom = null;
    this.releaseController?.();
    this.releaseController = null;
    this.releaseCommitFocus();
    this.destroyCurrent();
    this.live = false;
  }

  private releaseCommitFocus(): void {
    this.commitFocus?.destroy();
    this.commitFocus = null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.destroyed) throw new TypeError(`${this.definition.name} bridge is destroyed.`);
    const firstSubscriber = this.listeners.size === 0;
    this.activate();
    // connect() may have promoted the controller before the root action was
    // registered. The first effect subscription is the first point where the
    // committed root can be acquired synchronously.
    if (firstSubscriber && this.live) this.refreshDomOwnership();
    this.listeners.add(listener);
    listener();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.deactivate();
    };
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }

  readonly getSnapshot = (): Readonly<UIFnSnapshot<AnyRecord>> => {
    if (this.current) return this.current.getSnapshot();
    if (this.staticProjection) return this.staticProjection.snapshot;
    if (this.definition.kind === 'interactive-controller' && !this.destroyed) {
      this.current = this.create(false);
      return this.current.getSnapshot();
    }
    throw new TypeError(`${this.definition.name} has no current projection.`);
  };

  getGeneration(): number { return this.generation; }
  getLifecycleCounters(): Readonly<{
    controllerGeneration: number;
    controllerDestroyCount: number;
    activeControllers: number;
    domGeneration: number;
    domDestroyCount: number;
    registeredElements: number;
    subscribers: number;
  }> {
    return Object.freeze({
      controllerGeneration: this.generation,
      controllerDestroyCount: this.controllerDestroyCount,
      activeControllers: this.current ? 1 : 0,
      domGeneration: this.domGeneration,
      domDestroyCount: this.domDestroyCount,
      registeredElements: this.elements.size,
      subscribers: this.listeners.size,
    });
  }
  getController(): AnyController | null { return this.current; }
  getDomResources(): Readonly<UIFnDomResourceSnapshot> { return this.lastDomResources; }
  getActions(): AnyRecord { return this.current?.actions ?? {}; }
  getStatus(): string { return this.current?.status ?? this.staticProjection?.snapshot.status ?? 'idle'; }

  update(inputs: TInputs): void {
    if (this.destroyed) return;
    const previous = this.latestInputs.current as AnyRecord;
    const next = inputs as AnyRecord;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const currentState = this.current?.getState() ?? {};
    const changedKeys = [...keys]
      .filter((key) => inputChanged(key, previous[key], next[key]))
      .filter((key) => !(
        Object.prototype.hasOwnProperty.call(currentState, key)
        && equalInput(currentState[key], next[key])
      ));
    this.latestInputs.current = inputs;
    if (changedKeys.length === 0) return;
    if (this.definition.kind === 'typed-static-contract') {
      this.projectStatic();
      this.emit();
      return;
    }
    const previousVersion = this.current?.getSnapshot().version;
    this.current?.update(Object.fromEntries(changedKeys.map((key) => [key, next[key]])) as Partial<AnyRecord>);
    if (this.current?.getSnapshot().version === previousVersion) this.emit();
  }

  getPartProps(part: string, value: unknown, userProps: UIFnPartProps): UIFnPartProps {
    if (this.staticProjection) {
      const projected = this.staticProjection.parts[part];
      const generated = typeof projected === 'function'
        ? projected(value)
        : projected;
      if (!generated) throw new TypeError(`${this.definition.name}.${part} is absent from the public static contract.`);
      return mergePartProps(generated as UIFnPartProps, userProps);
    }
    const controllerPart = this.current?.parts[part] as { getProps(...args: unknown[]): UIFnPartProps } | undefined;
    if (!controllerPart) throw new TypeError(`${this.definition.name}.${part} is absent from the public core controller.`);
    return value === undefined ? controllerPart.getProps(userProps) : controllerPart.getProps(value, userProps);
  }

  registerElement(
    part: string,
    value: unknown,
    element: HTMLElement | null,
    portalTarget?: UIFnPortalTarget,
  ): void {
    if (this.destroyed) return;
    const key = `${part}:${value === undefined ? '' : String(value)}`;
    const previous = this.elements.get(key);
    if (element && previous?.element === element && Object.is(previous.portalTarget, portalTarget)) return;
    if (element) this.elements.set(key, { element, portalTarget });
    else this.elements.delete(key);
    this.scheduleDomOwnershipRefresh();
  }

  private scheduleDomOwnershipRefresh(): void {
    if (this.domRefreshQueued || this.destroyed) return;
    this.domRefreshQueued = true;
    const epoch = this.domRefreshEpoch;
    globalThis.queueMicrotask(() => {
      if (this.destroyed || epoch !== this.domRefreshEpoch) return;
      this.domRefreshQueued = false;
      this.refreshDomOwnership();
    });
  }

  /**
   * Svelte actions apply controller-driven attributes after store subscribers
   * run. Re-sync the already-owned DOM services once that commit has landed.
   */
  notifyDomCommit(): void {
    if (this.domCommitQueued || this.destroyed) return;
    this.domCommitQueued = true;
    const epoch = this.domRefreshEpoch;
    globalThis.queueMicrotask(() => {
      this.domCommitQueued = false;
      if (this.destroyed || epoch !== this.domRefreshEpoch) return;
      this.domBindings.forEach((binding) => {
        // Portal and gesture handles require update arguments; controller-
        // subscribed focus, overlay, and navigation bindings expose update().
        if (binding.update?.length === 0) binding.update();
      });
      this.commitFocus?.committed();
    });
  }

  getElement(part: string, value?: unknown): HTMLElement | null {
    return this.elements.get(`${part}:${value === undefined ? '' : String(value)}`)?.element ?? null;
  }

  getElementEntries(part: string): ReadonlyArray<{ value: string; element: HTMLElement }> {
    const prefix = `${part}:`;
    return [...this.elements.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => ({ value: key.slice(prefix.length), element: record.element }));
  }

  private refreshDomOwnership(): void {
    this.domRefreshEpoch += 1;
    this.domRefreshQueued = false;
    this.releaseDom?.();
    this.releaseDom = null;
    if (this.destroyed || (this.definition.kind === 'interactive-controller' && !this.live)) return;
    const root = this.getElement(this.definition.rootPart);
    if (!root) return;
    const lease = acquireUIFnDomPlatform({ root: root.ownerDocument });
    const bindings: SvelteDomBinding[] = [];
    const controller = this.current;
    try {
      const reset = controller?.actions.reset;
      if (typeof reset === 'function') {
        bindings.push(createUIFnNativeFormResetBinding(lease.platform.scope, root, () => reset()));
      }
      for (const [key, record] of this.elements) {
        if (!key.startsWith('portal:')) continue;
        bindings.push(createUIFnPortal(lease.platform.scope, {
          id: record.element.id || `${this.definition.name.toLowerCase()}-${stableToken(key)}`,
          node: record.element,
          target: record.portalTarget,
          restoreOnDestroy: true,
        }));
      }
      const portalManagedExternally = this.getElement('portal') !== null;
      for (const install of this.definition.domBindings ?? []) {
        install({
          bridge: this,
          controller,
          platform: lease.platform,
          root,
          portalManagedExternally,
          lateChildRegistration: true,
          add: (binding) => bindings.push(binding),
        });
      }
    } catch (error) {
      bindings.reverse().forEach((binding) => binding.destroy());
      lease.release();
      throw error;
    }
    let active = true;
    this.domGeneration += 1;
    this.domBindings = bindings;
    this.releaseDom = () => {
      if (!active) return;
      active = false;
      this.domDestroyCount += 1;
      this.domBindings = [];
      bindings.reverse().forEach((binding) => binding.destroy());
      lease.release();
      this.lastDomResources = Object.freeze({ ...lease.platform.scope.resources() });
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.domRefreshEpoch += 1;
    this.domRefreshQueued = false;
    this.domCommitQueued = false;
    this.releaseCommitFocus();
    this.domBindings = [];
    this.releaseDom?.();
    this.releaseDom = null;
    this.releaseController?.();
    this.releaseController = null;
    this.destroyCurrent();
    this.listeners.clear();
    this.elements.clear();
    this.live = false;
  }
}
