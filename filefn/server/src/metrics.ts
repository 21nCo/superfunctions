import {
  normalizeObservability,
  type ObservabilityConfigInput,
  type ObservabilityInput,
  type ObservationLogger,
  type ObservationMetric,
  type SuperfunctionObservability,
} from '@superfunctions/observability';
import type { FileFnObservationEvent } from './events.js';
import type { BackgroundScheduler } from './runtime.js';

/** The metric channel `createFileFn` already builds from `observability`. */
export type FileFnMetrics = Pick<
  SuperfunctionObservability<FileFnObservationEvent>,
  'metrics' | 'getCurrentRequest' | 'startRequest' | 'runWithRequest'
>;

function guardMetricSink(
  input: ObservabilityInput<FileFnObservationEvent>,
  track: BackgroundScheduler['track'],
): ObservabilityConfigInput<FileFnObservationEvent> | undefined {
  if (!input || 'startRequest' in input || !('metrics' in input)) return undefined;
  // Shared observability treats bare logger methods as the logger shorthand.
  const logger = input as ObservationLogger;
  const loggerMethods = ['info', 'debug', 'warn', 'error'] as const;
  if (loggerMethods.some((method) => typeof logger[method] === 'function')) return undefined;
  const sink = input.metrics;
  if (!sink) return undefined;
  return {
    service: input.service,
    component: input.component,
    labels: input.labels,
    logger: input.logger,
    events: input.events,
    requestContext: input.requestContext,
    metrics: (metric) => {
      try {
        const pending = typeof sink === 'function' ? sink(metric) : sink.record(metric);
        if (pending === undefined) return;
        const settled = Promise.resolve(pending).catch(() => {});
        if (metric.kind.startsWith('filefn.')) track(settled);
        return settled;
      } catch {
        // A telemetry failure must not change the result of a FileFn operation.
      }
    },
  };
}

export function createFileFnObservability(
  input: ObservabilityInput<FileFnObservationEvent>,
  track: BackgroundScheduler['track'],
) {
  const guarded = guardMetricSink(input, track);
  const scope = normalizeObservability(guarded ?? input)?.child({ component: 'filefn' });
  // An existing scope may discard the sink's promise. Enable the new domain
  // metrics only when FileFn can guard the underlying sink itself.
  return { scope, domainMetrics: guarded ? scope : undefined };
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
export function recordProcessingDuration(metrics: FileFnMetrics | undefined, durationMs: number, ok: boolean): void {
  void record(metrics, {
    kind: 'filefn.processing',
    operation: 'complete',
    ok,
    durationMs: Math.max(0, durationMs),
  }, true);
}
