/**
 * LiveSignal — lifecycle-aware signal wrapper that survives switchContext().
 *
 * A LiveSignal holds a factory closure that creates raw signals.
 * When rebind() is called (by LiveSignalRegistry after a context switch),
 * the factory is re-invoked to produce a new raw signal bound to the new
 * realClient, and existing subscribers continue receiving updates.
 */

import type { DatafnSignal, DatafnError } from "@datafn/core";
import { dfqlKey } from "@datafn/core";
import type { DatafnSignalCacheOptions, DatafnSignalOptions } from "./options.js";

type SignalFactory<T> = () => DatafnSignal<T>;
type UnsubscribeFn = () => void;
type LiveSignalChangeHandler<T> = (signal: LiveSignal<T>) => void;

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_IDLE_SIGNALS = 200;

export class LiveSignal<T> implements DatafnSignal<T> {
  private raw: DatafnSignal<T> | null = null;
  private rawUnsub: UnsubscribeFn | null = null;
  private disposed = false;
  private lastValue: T | undefined = undefined;
  private currentError: DatafnError | null = null;
  private subscribers = new Set<(value: T) => void>();
  private lastAccessedAt = Date.now();
  // Set when the last reader unsubscribes; cleared when one subscribes.
  private readersLeft = false;

  /**
   * Set by the Proxy layer (Phase 2) to unsubscribe from the client lifecycle.
   * null until wired in.
   */
  lifecycleUnsub: UnsubscribeFn | null = null;

  constructor(
    private factory: SignalFactory<T>,
    private removeFromRegistry: () => void,
    private cacheOptions?: DatafnSignalCacheOptions,
    private onSubscriberChange?: LiveSignalChangeHandler<T>,
  ) {
    this.bindRaw();
  }

  private bindRaw(): void {
    try {
      this.raw = this.factory();
      this.attachRaw();
    } catch (err: any) {
      this.currentError = {
        code: "INTERNAL",
        message: err?.message ?? "Signal factory failed",
        details: err,
      };
      this.raw = null;
      this.rawUnsub = null;
    }
  }

  /**
   * Follows the raw signal. Once every reader has left, it is followed only
   * until it settles on a value, so writes don't re-run its query while no
   * one reads it (the raw signal re-reads when it is followed again).
   */
  private attachRaw(): void {
    if (!this.raw || this.rawUnsub) return;
    let attaching = true;
    let detachOnceAttached = false;
    const unsub = this.raw.subscribe((value) => {
      // The raw signal delivers its cached value on subscribe; subscribers
      // already have it when it is the value they last saw.
      if (!(attaching && value === this.lastValue)) {
        this.lastValue = value;
        this.subscribers.forEach((fn) => fn(value));
      }
      if (this.canDetachIdle()) {
        if (attaching) detachOnceAttached = true;
        else this.detachRaw();
      }
    });
    attaching = false;
    this.rawUnsub = unsub;
    if (detachOnceAttached && this.canDetachIdle()) this.detachRaw();
  }

  private detachRaw(): void {
    this.rawUnsub?.();
    this.rawUnsub = null;
  }

  /**
   * Every reader has left and the raw signal holds a settled value, so it
   * can stop being followed.
   */
  private canDetachIdle(): boolean {
    return (
      this.readersLeft &&
      this.subscribers.size === 0 &&
      this.lastValue !== undefined &&
      !(this.raw as any)?.loading
    );
  }

  private unbindRaw(): void {
    this.rawUnsub?.();
    this.rawUnsub = null;
    try {
      this.raw?.dispose();
    } catch {
      // Raw signal may already be disposed by realClient.destroy() — ignore
    }
    this.raw = null;
  }

  /**
   * Rebind to a new raw signal from the factory.
   * Called by LiveSignalRegistry.rebindAll() after a context switch.
   */
  rebind(): void {
    if (this.disposed) return;
    this.unbindRaw();
    this.currentError = null;
    // The new raw signal loads now, even while idle, so get() moves to the
    // new context; an idle signal stops following it once it settles.
    this.bindRaw();
    // If the new raw signal already has a value (e.g. cached), emit to subscribers.
    // Note: bindRaw's internal handler also emits when raw.subscribe() delivers synchronously.
    if (this.raw !== null) {
      const current = this.raw.get();
      if (current !== undefined) {
        this.lastValue = current;
        this.subscribers.forEach((fn) => fn(current));
      }
    }
  }

  get(): T {
    this.touch();
    return (this.raw?.get() ?? this.lastValue) as T;
  }

  subscribe(handler: (value: T) => void): () => void {
    if (this.disposed) return () => {};
    const wasIdle = this.subscribers.size === 0;
    this.touch();
    this.readersLeft = false;
    this.subscribers.add(handler);
    this.onSubscriberChange?.(this);
    if (this.lastValue !== undefined) {
      handler(this.lastValue);
    }
    if (wasIdle && this.lastValue !== undefined) {
      queueMicrotask(() => {
        // Skip when returning already started a re-read (a write arrived
        // while idle).
        const raw = this.raw as any;
        if (!this.disposed && this.subscribers.size > 0 && !raw?.refreshing && !raw?.loading) {
          void raw?.refresh?.();
        }
      });
    }
    if (wasIdle) this.attachRaw();
    return () => {
      if (this.subscribers.delete(handler)) {
        this.touch();
        if (this.subscribers.size === 0) {
          this.readersLeft = true;
          // Keep the raw signal (and its cached result) but stop following
          // it; a read still loading detaches when it settles.
          if (this.canDetachIdle()) this.detachRaw();
        }
        this.onSubscriberChange?.(this);
      }
    };
  }

  touch(): void {
    this.lastAccessedAt = Date.now();
  }

  updateCacheOptions(options: DatafnSignalCacheOptions | undefined): void {
    if (!options) return;
    this.cacheOptions = {
      ...this.cacheOptions,
      ...options,
    };
  }

  get activeSubscriberCount(): number {
    return this.subscribers.size;
  }

  get isIdle(): boolean {
    return this.subscribers.size === 0;
  }

  get accessedAt(): number {
    return this.lastAccessedAt;
  }

  get keepAlive(): boolean {
    return this.cacheOptions?.keepAlive === true;
  }

  get idleTtlMs(): number | undefined {
    return this.cacheOptions?.idleTtlMs;
  }

  get loading(): boolean {
    return this.raw?.loading ?? false;
  }

  get error(): DatafnError | null {
    return this.currentError ?? this.raw?.error ?? null;
  }

  get refreshing(): boolean {
    return this.raw?.refreshing ?? false;
  }

  get nextCursor(): string | null {
    return (this.raw as any)?.nextCursor ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindRaw();
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.removeFromRegistry();
    this.subscribers.clear();
  }
}

export class LiveSignalRegistry {
  private signals = new Map<string, LiveSignal<any>>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private options: {
      defaultIdleTtlMs?: number;
      maxIdleSignals?: number;
    } = {},
  ) {}

  getOrCreateTableSignal<T>(
    name: string,
    version: number,
    query: unknown,
    options: DatafnSignalOptions | undefined,
    factory: SignalFactory<T>,
  ): DatafnSignal<T> {
    const key = dfqlKey({ resource: name, version, ...(query as object) });
    if (this.signals.has(key)) {
      const cached = this.signals.get(key) as LiveSignal<T>;
      this.markAccessed(key, cached, options?.cache);
      return cached as DatafnSignal<T>;
    }
    let signal!: LiveSignal<T>;
    signal = new LiveSignal<T>(
      factory,
      () => this.removeSignal(key),
      options?.cache,
      () => this.handleSubscriberChange(key, signal),
    );
    this.trackSignal(key, signal);
    return signal;
  }

  getOrCreateKvSignal<T>(
    key: string,
    options: DatafnSignalOptions | undefined,
    factory: SignalFactory<T>,
  ): DatafnSignal<T> {
    const registryKey = `kv:${key}`;
    if (this.signals.has(registryKey)) {
      const cached = this.signals.get(registryKey) as LiveSignal<T>;
      this.markAccessed(registryKey, cached, options?.cache);
      return cached as DatafnSignal<T>;
    }
    let signal!: LiveSignal<T>;
    signal = new LiveSignal<T>(
      factory,
      () => this.removeSignal(registryKey),
      options?.cache,
      () => this.handleSubscriberChange(registryKey, signal),
    );
    this.trackSignal(registryKey, signal);
    return signal;
  }

  getOrCreateSignal<T>(
    key: string,
    options: DatafnSignalOptions | undefined,
    factory: SignalFactory<T>,
  ): DatafnSignal<T> {
    const registryKey = `signal:${key}`;
    if (this.signals.has(registryKey)) {
      const cached = this.signals.get(registryKey) as LiveSignal<T>;
      this.markAccessed(registryKey, cached, options?.cache);
      return cached as DatafnSignal<T>;
    }
    let signal!: LiveSignal<T>;
    signal = new LiveSignal<T>(
      factory,
      () => this.removeSignal(registryKey),
      options?.cache,
      () => this.handleSubscriberChange(registryKey, signal),
    );
    this.trackSignal(registryKey, signal);
    return signal;
  }

  private trackSignal(key: string, signal: LiveSignal<any>): void {
    this.signals.set(key, signal);
    this.scheduleIdleEviction(key, signal);
    this.evictOverflowIdleSignals();
  }

  private markAccessed(
    key: string,
    signal: LiveSignal<any>,
    cacheOptions?: DatafnSignalCacheOptions,
  ): void {
    signal.updateCacheOptions(cacheOptions);
    signal.touch();
    this.scheduleIdleEviction(key, signal);
    this.evictOverflowIdleSignals();
  }

  private handleSubscriberChange(key: string, signal: LiveSignal<any>): void {
    this.scheduleIdleEviction(key, signal);
    this.evictOverflowIdleSignals();
  }

  private clearIdleTimer(key: string): void {
    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }
  }

  private scheduleIdleEviction(key: string, signal: LiveSignal<any>): void {
    this.clearIdleTimer(key);
    if (!signal.isIdle || signal.keepAlive) {
      return;
    }

    const ttl = signal.idleTtlMs ?? this.options.defaultIdleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (ttl <= 0) {
      signal.dispose();
      return;
    }

    const timer = setTimeout(() => {
      if (this.signals.get(key) === signal && signal.isIdle && !signal.keepAlive) {
        signal.dispose();
      }
    }, ttl);
    (timer as any).unref?.();
    this.idleTimers.set(key, timer);
  }

  private evictOverflowIdleSignals(): void {
    const maxIdleSignals = this.options.maxIdleSignals ?? DEFAULT_MAX_IDLE_SIGNALS;
    if (maxIdleSignals < 0) {
      return;
    }

    const idleSignals = Array.from(this.signals.entries())
      .filter(([, signal]) => signal.isIdle && !signal.keepAlive)
      .sort(([, a], [, b]) => a.accessedAt - b.accessedAt);

    while (idleSignals.length > maxIdleSignals) {
      const [key, signal] = idleSignals.shift()!;
      if (this.signals.get(key) === signal && signal.isIdle && !signal.keepAlive) {
        signal.dispose();
      }
    }
  }

  private removeSignal(key: string): void {
    this.clearIdleTimer(key);
    this.signals.delete(key);
  }

  rebindAll(): void {
    const signals = Array.from(this.signals.values());
    for (const signal of signals) {
      try {
        signal.rebind();
      } catch {
        // One failure must not prevent others from rebinding
      }
    }
  }

  disposeAll(): void {
    const signals = Array.from(this.signals.values());
    for (const signal of signals) {
      signal.dispose();
    }
    this.signals.clear();
  }
}
