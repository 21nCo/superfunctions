import { describe, expect, it, vi } from 'vitest';
import { createBackgroundScheduler } from '../runtime.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('createBackgroundScheduler', () => {
  it('starts scheduled work after the current turn and hands it to defer', async () => {
    const defer = vi.fn();
    const task = vi.fn(async () => 'done');
    const scheduler = createBackgroundScheduler({ defer });

    scheduler.schedule(task);

    expect(task).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
    await defer.mock.calls[0][0];
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('gives defer a promise that resolves after the work, even when the work rejects', async () => {
    const defer = vi.fn();
    const log = logger();
    const scheduler = createBackgroundScheduler({ defer }, log);

    scheduler.schedule(async () => {
      throw new Error('boom');
    });

    await expect(defer.mock.calls[0][0]).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('background work failed', expect.objectContaining({ error: expect.stringContaining('boom') }));
  });

  it('tracks an already-running promise without restarting it', async () => {
    const defer = vi.fn();
    const scheduler = createBackgroundScheduler({ defer });
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });

    scheduler.track(pending);
    resolvePending();

    await expect(defer.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it('runs scheduled work detached and logs a throwing hook', async () => {
    const log = logger();
    const task = vi.fn(async () => undefined);
    const scheduler = createBackgroundScheduler({
      defer() {
        throw new Error('no context');
      },
    }, log);

    expect(() => scheduler.schedule(task)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();

    expect(task).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('runtime.defer hook failed', expect.objectContaining({ error: expect.stringContaining('no context') }));
  });

  it('falls back to setTimeout where setImmediate does not exist', async () => {
    const original = globalThis.setImmediate;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    // @ts-expect-error simulating a runtime without setImmediate
    delete globalThis.setImmediate;
    try {
      const defer = vi.fn();
      const task = vi.fn(async () => undefined);
      createBackgroundScheduler({ defer }).schedule(task);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
      await defer.mock.calls[0][0];
      expect(task).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setImmediate = original;
      setTimeoutSpy.mockRestore();
    }
  });
});
