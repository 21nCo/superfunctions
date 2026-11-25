import { AsyncResource } from 'node:async_hooks';
import type { SuperfunctionObservability } from '@superfunctions/observability';
import type { FileFnObservationEvent } from './events.js';

/**
 * Created as the module loads, outside any request. Inline processing records
 * its duration after the response, when the request observation is already
 * finished and would otherwise drop the metric.
 */
const outsideRequest = new AsyncResource('filefn-metrics');

/** The metric channel `createFileFn` already builds from `observability`. */
export type FileFnMetrics = Pick<SuperfunctionObservability<FileFnObservationEvent>, 'record'>;

/**
 * Why an upload failed, as a label. A closed set so a metric backend can
 * count it: never a session id, a storage key, or an adapter's own text.
 */
export type UploadFailureReason = 'size_unverified' | 'parts_missing' | 'size_mismatch';

function record(metrics: FileFnMetrics | undefined, metric: Parameters<FileFnMetrics['record']>[0]): void {
  if (!metrics) return;
  outsideRequest.runInAsyncScope(() => {
    metrics.record(metric);
  });
}

/** One handled upload failure. `reason` is the only label. */
export function recordUploadFailure(metrics: FileFnMetrics | undefined, reason: UploadFailureReason): void {
  record(metrics, {
    kind: 'filefn.upload',
    operation: 'failure',
    ok: false,
    labels: { reason },
  });
}

/** One quota check that refused the upload. No usage figures. */
export function recordQuotaDenial(metrics: FileFnMetrics | undefined): void {
  record(metrics, {
    kind: 'filefn.quota',
    operation: 'denied',
    ok: false,
  });
}

/** Wall time of one processing run that reached `processing.completed`. */
export function recordProcessingDuration(metrics: FileFnMetrics | undefined, durationMs: number): void {
  record(metrics, {
    kind: 'filefn.processing',
    operation: 'complete',
    ok: true,
    durationMs: Math.max(0, durationMs),
  });
}
