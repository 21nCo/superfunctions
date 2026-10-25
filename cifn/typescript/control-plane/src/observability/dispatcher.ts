import { createLogger, type Sink } from '@logfn/core';
import type { DatabaseStore } from '../store/database-store.js';
import type { LifecycleEvent } from './lifecycle.js';

/** Actual LogFn pipeline; success means the configured sink and flush resolved, not remote durable acceptance. */
export async function deliverLifecycleEvent(event: LifecycleEvent, sink: Sink): Promise<void> {
  let failed = false;
  let emitted = false;
  const guarded: Sink = batch => {
    if (batch.length !== 1 || batch[0].ctx?._truncated || batch[0].ctx?.eventId !== event.id || batch[0].ctx?.sequence !== event.sequence) {
      failed = true; return;
    }
    emitted = true; return sink(batch);
  };
  guarded.flush = () => sink.flush?.() ?? Promise.resolve();
  const logger = createLogger({ name: 'cifn', level: 'info', now: () => new Date(event.timestamp),
    redaction: { allowlist: ['/ctx/eventId', '/ctx/sequence', '/ctx/runId', '/ctx/jobKey', '/ctx/stepKey', '/ctx/status', '/ctx/runnerId', '/ctx/code', '/ctx/route', '/ctx/method'] },
    onError: () => { failed = true; }, sinks: [guarded],
  });
  logger.info(event.type, { eventId: event.id, sequence: event.sequence, ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.runnerId === undefined ? {} : { runnerId: event.runnerId }),
    ...(event.code === undefined ? {} : { code: event.code }), ...(event.route === undefined ? {} : { route: event.route }),
    ...(event.method === undefined ? {} : { method: event.method }),
    ...(event.jobKey === undefined ? {} : { jobKey: event.jobKey }),
    ...(event.stepKey === undefined ? {} : { stepKey: event.stepKey }), status: event.status });
  try { await logger.flush(); } catch { failed = true; }
  if (failed || !emitted) throw new Error('CiFn LogFn delivery outcome requires reconciliation');
}

/** Host-driven, one finite page at a time. No retries of ambiguous sink effects. */
export class LogFnLifecycleDispatcher {
  private active?: Promise<{ nextCursor?: string; delivered: number }>;
  private closed = false;
  constructor(private readonly store: DatabaseStore, private readonly sink: Sink, private readonly leaseMs = 60_000) {
    if (typeof sink !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error('Invalid LogFn lifecycle dispatcher configuration');
  }
  tick(cursor?: string): Promise<{ nextCursor?: string; delivered: number }> {
    if (this.closed) return Promise.reject(new Error('LogFn lifecycle dispatcher is closed'));
    if (this.active) return Promise.reject(new Error('LogFn lifecycle dispatch already active'));
    const operation = this.dispatch(cursor);
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; }).catch(() => {});
    return operation;
  }
  private async dispatch(cursor?: string): Promise<{ nextCursor?: string; delivered: number }> {
    const page = await this.store.listLifecycleOwners(cursor);
    let delivered = 0;
    for (const owner of page.owners) {
      if (this.closed) break;
      const record = await this.store.claimTelemetry(owner, Date.now(), this.leaseMs);
      if (!record) continue;
      let outcome: 'delivered' | 'unknown' = 'unknown';
      try { await deliverLifecycleEvent(record.event, this.sink); outcome = 'delivered'; } catch { /* Persist sanitized ambiguity, never raw sink error. */ }
      const finishedAt = Date.now();
      const recorded = await this.store.finishTelemetry(owner, record.event.id, record.claim!.token, outcome, finishedAt);
      if (!recorded) throw new Error('CiFn lifecycle receipt could not be committed');
      if (outcome === 'delivered' && record.claim!.expiresAt > finishedAt) delivered++;
    }
    return { nextCursor: page.nextCursor, delivered };
  }
  /** Closes admission, then joins the owned sink operation. Arbitrary sinks have no hard cancellation guarantee. */
  async close(): Promise<void> { this.closed = true; await this.active; }
}
