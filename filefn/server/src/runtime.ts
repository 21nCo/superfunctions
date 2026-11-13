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
   * never rejects. Called synchronously while the request that triggered the
   * work is still being handled. Without it, work runs detached (on Node it is
   * scheduled with `setImmediate`, as before this hook existed).
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function createBackgroundScheduler(runtime?: FileFnRuntime, logger?: Logger): BackgroundScheduler {
  const defer = runtime?.defer;

  function hand(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      (error: unknown) => {
        logger?.error('background work failed', { error: errorMessage(error) });
      },
    );
    if (!defer) return;
    try {
      defer(settled);
    } catch (error) {
      // The work is already running; a failing hook only loses lifetime extension.
      logger?.error('runtime.defer hook failed', { error: errorMessage(error) });
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
