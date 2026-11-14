import { describe, expect, it, vi } from 'vitest';
import { createBackgroundScheduler, type FileFnRuntime } from '../runtime.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function throwingLogger() {
  const error = vi.fn(() => {
    throw new Error('logger down');
  });
  return { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() };
}

/** Lets timers, immediates and microtasks queued by the scheduler run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** A hook in the shape a Worker writes it: a method that reads its context through `this`. */
class WaitUntilRuntime implements FileFnRuntime {
  constructor(private readonly ctx: { waitUntil(work: Promise<unknown>): void }) {}
  defer(work: Promise<unknown>): void {
    this.ctx.waitUntil(work);
  }
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

  it('calls a method-style defer hook with its receiver for scheduled and tracked work', async () => {
    const waitUntil = vi.fn();
    const log = logger();
    const runtime = new WaitUntilRuntime({ waitUntil });
    const scheduler = createBackgroundScheduler(runtime, log);

    scheduler.schedule(async () => undefined);
    scheduler.track(Promise.resolve());

    expect(waitUntil).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    await Promise.all(waitUntil.mock.calls.map(([work]) => work));
  });

  it('never rejects or throws when the logger throws', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // No hook: rejecting work runs detached, so a rejecting log path would go unhandled.
      const detached = createBackgroundScheduler(undefined, throwingLogger());
      detached.schedule(async () => {
        throw new Error('work failed');
      });
      detached.track(Promise.reject(new Error('fan-out failed')));

      // With a hook: the deferred promise still resolves.
      const defer = vi.fn();
      const log = throwingLogger();
      createBackgroundScheduler({ defer }, log).schedule(async () => {
        throw new Error('work failed');
      });
      await expect(defer.mock.calls[0][0]).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith('background work failed', expect.anything());

      // A throwing hook with a throwing logger does not throw into the caller.
      const failing = createBackgroundScheduler({
        defer() {
          throw new Error('no context');
        },
      }, throwingLogger());
      expect(() => failing.schedule(async () => undefined)).not.toThrow();
      expect(() => failing.track(Promise.reject(new Error('fan-out failed')))).not.toThrow();

      await drain();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
