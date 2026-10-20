import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigRefreshLoop } from '../core/config-refresh';
import { ConfigRefreshError } from '../core/config-http';
afterEach(() => { vi.useRealTimers(); });

describe('serial background configuration refresh', () => {
  it('starts once, preserves a success interval, stops and restarts without duplicate timers', async () => {
    vi.useFakeTimers(); const refresh = vi.fn(async () => true); const cancel = vi.fn(async () => {});
    const loop = new ConfigRefreshLoop(refresh, cancel, 100);
    loop.start(); loop.start(); await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledTimes(1);
    expect(loop.status()).toMatchObject({ running: true, consecutiveFailures: 0, lastSuccessAt: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(100); expect(refresh).toHaveBeenCalledTimes(2);
    await Promise.all([loop.stop(), loop.stop()]); await vi.advanceTimersByTimeAsync(500); expect(refresh).toHaveBeenCalledTimes(2);
    loop.start(); await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledTimes(3);
    await loop.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports errors, backs off to its cap and resets after a verified success', async () => {
    vi.useFakeTimers(); let fail = true;
    const refresh = vi.fn(async () => { if (fail) throw new ConfigRefreshError('fixed failure'); return false; });
    const loop = new ConfigRefreshLoop(refresh, async () => {}, 1000); loop.start(); await vi.advanceTimersByTimeAsync(0);
    expect(loop.status()).toMatchObject({ lastError: 'fixed failure', consecutiveFailures: 1 });
    expect(loop.status().nextRefreshAt! - Date.now()).toBe(2000);
    for (let count = 0; count < 12; count++) { const delay = loop.status().nextRefreshAt! - Date.now(); expect(delay).toBeLessThanOrEqual(300000); await vi.advanceTimersByTimeAsync(delay); }
    expect(loop.status().nextRefreshAt! - Date.now()).toBe(300000);
    fail = false; await vi.advanceTimersByTimeAsync(300000);
    expect(loop.status()).toMatchObject({ consecutiveFailures: 0, lastError: undefined });
    expect(loop.status().nextRefreshAt! - Date.now()).toBe(1000); await loop.stop();
  });

  it('never overlaps slow refreshes and awaits cancellation on stop', async () => {
    vi.useFakeTimers(); let reject: (error: unknown) => void = () => {};
    const refresh = vi.fn(() => new Promise<boolean>((_, fail) => { reject = fail; }));
    const loop = new ConfigRefreshLoop(refresh, async () => { reject(new ConfigRefreshError('cancelled')); }, 100);
    loop.start(); await vi.advanceTimersByTimeAsync(1000); expect(refresh).toHaveBeenCalledTimes(1);
    await loop.stop(); expect(loop.status()).toMatchObject({ running: false, consecutiveFailures: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unbounded or invalid intervals', () => {
    for (const interval of [0, 99, 86400001, NaN, Infinity, 100.5]) expect(() => new ConfigRefreshLoop(async () => true, async () => {}, interval)).toThrow(TypeError);
  });
});
