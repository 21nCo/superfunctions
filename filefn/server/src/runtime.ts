import type { Logger } from './observability/logger.js';

/**
 * Host runtime hooks. FileFn runs some work after a response is produced:
 * processing when no queue is configured, and event fan-out to observability
 * sinks. A host whose runtime ends work with the response wires `defer` to its
 * lifetime extension, for example `ctx.waitUntil` on Cloudflare Workers.
 */
export interface FileFnRuntime {
  /**
   * Receives each piece of background work as an already-started promise that
   * never rejects. FileFn calls it as a method (`runtime.defer(work)`), so a
   * hook may use `this`. It is called synchronously while the triggering
   * request is handled, and also from deferred work itself: processing emits
   * events whose fan-out is deferred after the response, while the earlier
   * deferred work is still pending (Workers' `ctx.waitUntil` accepts that).
   * Without it, work runs detached (on Node it is scheduled with
   * `setImmediate`, as before this hook existed).
   */
  defer?(work: Promise<unknown>): void;
}

/** Hands background work to the runtime's `defer` hook. */
export interface BackgroundScheduler {
  /** Starts `task` on a later event-loop turn, never inline, and defers it. */
  schedule(task: () => Promise<unknown>): void;
  /** Defers an already-running promise; its rejection is logged, not thrown. */
  track(pending: Promise<unknown>): void;
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function createBackgroundScheduler(runtime?: FileFnRuntime, logger?: Logger): BackgroundScheduler {
  /** Logs a background failure; never throws, so it cannot reject work or break a request. */
  function report(message: string, error: unknown): void {
    try {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      logger?.error(message, { error: detail });
    } catch {
      // A failing logger must not turn a logged failure into a new one.
    }
  }

  function hand(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      (error: unknown) => report('background work failed', error),
    );
    if (typeof runtime?.defer !== 'function') return;
    try {
      // Called on `runtime` so a method-style hook keeps its receiver.
      runtime.defer(settled);
    } catch (error) {
      // The work is already running; a failing hook only loses lifetime extension.
      report('runtime.defer hook failed', error);
    }
  }

  return {
    schedule(task) {
      hand(nextTurn().then(task));
    },
    track(pending) {
      hand(pending);
    },
  };
}
