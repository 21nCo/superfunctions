export interface MetricsEmitter {
  track(event: string, properties?: Record<string, unknown>): void;
}

export function createMetricsEmitter(
  trackFn?: (event: string, properties?: Record<string, unknown>) => void,
): MetricsEmitter {
  if (!trackFn) {
    return {
      track() {},
    };
  }

  return {
    track(event: string, properties?: Record<string, unknown>): void {
      trackFn(event, properties);
    },
  };
}

export function createNamespacedEmitter(namespace: string, emitter: MetricsEmitter): MetricsEmitter {
  const normalized = namespace.trim();
  if (!normalized || normalized.includes('..')) {
    throw new Error('METRIC_NAMESPACE_INVALID');
  }

  return {
    track(event: string, properties?: Record<string, unknown>): void {
      const eventName = event.startsWith(`${normalized}.`) ? event : `${normalized}.${event}`;
      emitter.track(eventName, properties);
    },
  };
}
