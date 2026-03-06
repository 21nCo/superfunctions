/**
 * Metrics emission wrapper for watchfn or equivalent.
 * When a track callback is provided (e.g. from watchfn), metrics are emitted.
 * Otherwise, no-op.
 */
export interface MetricsEmitter {
  track(event: string, properties?: Record<string, unknown>): void;
}

/**
 * Create a metrics emitter. When trackFn is provided, metrics are emitted via it.
 * Otherwise, a no-op emitter is returned.
 */
export function createMetricsEmitter(
  trackFn?: (event: string, properties?: Record<string, unknown>) => void,
): MetricsEmitter {
  if (!trackFn) {
    return {
      track() {},
    };
  }
  return {
    track(event: string, properties?: Record<string, unknown>) {
      trackFn(event, properties);
    },
  };
}
