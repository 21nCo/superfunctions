import type { ObservabilityInput, ObservationMetric, SuperfunctionObservability } from '@superfunctions/observability';
import type { FileFnObservationEvent } from './events.js';

/** The metric channel `createFileFn` already builds from `observability`. */
export type FileFnMetrics = Pick<
  SuperfunctionObservability<FileFnObservationEvent>,
  'metrics' | 'getCurrentRequest' | 'startRequest' | 'runWithRequest'
>;

export function withSafeMetricSink(input: ObservabilityInput<FileFnObservationEvent>): typeof input {
  if (!input || 'startRequest' in input || !('metrics' in input) || !input.metrics) return input;
  const sink = input.metrics;
  return {
    ...input,
    metrics: async (metric) => {
      try {
        await (typeof sink === 'function' ? sink(metric) : sink.record(metric));
      } catch {
        // A telemetry failure must not change the result of a FileFn operation.
      }
    },
  };
}

/**
 * Why an upload failed, as a label. A closed set so a metric backend can
 * count it: never a session id, a storage key, or an adapter's own text.
 */
export type UploadFailureReason = 'size_unverified' | 'parts_missing' | 'size_mismatch';

async function record(
  metrics: FileFnMetrics | undefined,
  metric: ObservationMetric,
  separateObservation = false,
): Promise<void> {
  if (!metrics) return;
  try {
    const emit = () => metrics.metrics.record(metric);
    if (separateObservation && metrics.getCurrentRequest()) {
      // Inline processing may inherit a finished request. Use a fresh scope
      // so that request can't discard the observation.
      await metrics.runWithRequest(metrics.startRequest(), emit);
    } else {
      await emit();
    }
  } catch {
    // Custom observability implementations can return rejected promises.
  }
}

/** One handled upload failure. `reason` is the only label. */
export function recordUploadFailure(metrics: FileFnMetrics | undefined, reason: UploadFailureReason): void {
  void record(metrics, {
    kind: 'filefn.upload',
    operation: 'failure',
    ok: false,
    labels: { reason },
  });
}

/** One quota check that refused the upload. No usage figures. */
export function recordQuotaDenial(metrics: FileFnMetrics | undefined): void {
  void record(metrics, {
    kind: 'filefn.quota',
    operation: 'denied',
    ok: false,
  });
}

/** Wall time of one processing run that reached `processing.completed`. */
export function recordProcessingDuration(metrics: FileFnMetrics | undefined, durationMs: number): void {
  void record(metrics, {
    kind: 'filefn.processing',
    operation: 'complete',
    ok: true,
    durationMs: Math.max(0, durationMs),
  }, true);
}
