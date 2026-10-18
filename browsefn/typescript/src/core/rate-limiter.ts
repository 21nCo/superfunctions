/** Aggregate global and provider windows backed by the shared limiter. */
import type { RateLimiter as SharedRateLimiter } from '@superfunctions/middleware/rate-limit';
import { BrowseFnError } from './errors.js';
import type { RateLimitConfig, RateLimitStatus } from './types.js';

type RateLimitListener = (status: RateLimitStatus) => void;
interface WindowState { config: RateLimitConfig; limiter?: Promise<SharedRateLimiter>; status?: RateLimitStatus; key: string; }
const UNBOUNDED = { remaining: Infinity, resetAt: 0, limit: Infinity, allowed: true, retryAfterMs: 0 };

export class RateLimiter {
  private readonly providers = new Map<string, WindowState>();
  private readonly global?: WindowState;
  private readonly listeners = new Set<RateLimitListener>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(globalConfig?: RateLimitConfig, perProviderConfigs?: Record<string, RateLimitConfig>) {
    if (globalConfig) this.global = this.window(globalConfig, 'global');
    for (const [provider, config] of Object.entries(perProviderConfigs ?? {})) this.providers.set(provider, this.window(config, `provider:${provider}`));
  }
  private window(config: RateLimitConfig, key: string): WindowState {
    if (!Number.isInteger(config.requests) || config.requests <= 0 || !Number.isFinite(config.window) || config.window <= 0) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Rate limits require positive integer requests and a positive finite window.' });
    return { config: { ...config }, key };
  }
  private states(provider: string): WindowState[] {
    return [this.global, this.providers.get(provider)].filter((state): state is WindowState => !!state);
  }
  private limiter(state: WindowState): Promise<SharedRateLimiter> {
    return state.limiter ??= import('@superfunctions/middleware/rate-limit').then(({ createRateLimiter }) => createRateLimiter({ windowMs: state.config.window, maxRequests: state.config.requests, keyPrefix: 'browsefn:', algorithm: 'fixed-window' }));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }
  private status(state: WindowState): RateLimitStatus {
    if (state.status && Date.now() < state.status.resetAt) return state.status;
    return { remaining: state.config.requests, resetAt: Date.now() + state.config.window, limit: state.config.requests, allowed: true, retryAfterMs: 0 };
  }
  getImportPath(): string { return '@superfunctions/middleware/rate-limit'; }
  onRateLimited(listener: RateLimitListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async check(provider: string): Promise<RateLimitStatus> {
    return this.serial(async () => {
      const states = this.states(provider);
      // All writes go through this queue, so fixed-window snapshots preflight both
      // quotas without charging one when the other is already exhausted.
      if (states.some(state => this.status(state).remaining <= 0)) {
        const blocked = { ...this.getStatus(provider), allowed: false };
        this.listeners.forEach(listener => listener(blocked));
        return blocked;
      }
      for (const state of states) {
        const result = await (await this.limiter(state)).check({ key: state.key });
        state.status = { allowed: result.allowed, remaining: result.remaining, limit: result.total, resetAt: Date.parse(result.resetAt) };
      }
      const status = this.getStatus(provider);
      // Remaining zero after this successful consumption means the next call blocks.
      return { ...status, allowed: states.every(state => state.status?.allowed !== false) };
    });
  }
  async checkLimit(provider: string): Promise<boolean> { return (await this.check(provider)).allowed !== false; }
  async waitForLimit(provider: string): Promise<void> {
    for (;;) {
      const status = await this.check(provider);
      if (status.allowed !== false) return;
      await new Promise(resolve => setTimeout(resolve, Math.max(25, status.retryAfterMs ?? 0)));
    }
  }
  getStatus(provider: string): RateLimitStatus {
    const states = this.states(provider).map(state => this.status(state));
    if (!states.length) return { ...UNBOUNDED, provider };
    const blocked = states.filter(state => state.remaining <= 0);
    const resetAt = Math.max(...(blocked.length ? blocked : states).map(state => state.resetAt));
    return { remaining: Math.min(...states.map(state => state.remaining)), resetAt, limit: Math.min(...states.map(state => state.limit)), allowed: !blocked.length, provider, retryAfterMs: blocked.length ? Math.max(0, resetAt - Date.now()) : 0 };
  }
  async consume(provider: string): Promise<void> {
    const status = await this.check(provider);
    if (status.allowed === false) throw new BrowseFnError({ code: 'RATE_LIMITED', message: `Rate limit exceeded for provider ${provider}.`, provider, retryAfterMs: status.retryAfterMs });
  }
  async reset(provider?: string): Promise<void> {
    await this.serial(async () => {
      // A configured provider reset preserves aggregate usage; legacy global-only resets clear its sole window.
      const states = provider ? [this.providers.get(provider) ?? this.global] : [this.global, ...this.providers.values()];
      for (const state of states) if (state) { if (state.limiter) await (await state.limiter).reset(state.key); state.status = undefined; }
    });
  }
  setConfig(provider: string, config: RateLimitConfig): void { this.providers.set(provider, this.window(config, `provider:${provider}`)); }
}
