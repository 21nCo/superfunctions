import { createLogger, type Sink } from '@logfn/core';
import type { DatabaseStore } from '../store/database-store.js';
import type { StepOutputDelivery } from '../log-delivery/forwarding.js';

/** Preserve the admitted redacted line; never claim delivery if the logger changes or drops it. */
export async function deliverStepOutput(delivery: StepOutputDelivery, sink: Sink): Promise<void> {
  let failed = false, emitted = false;
  const guarded: Sink = batch => {
    if (Date.now() >= delivery.claimExpiresAt || Date.now() >= delivery.payloadExpiresAt || batch.length !== 1 || batch[0].ctx?._truncated || batch[0].ctx?.eventId !== delivery.eventId || batch[0].msg !== delivery.event.msg) { failed = true; return; }
    emitted = true; return sink(batch);
  };
  guarded.flush = () => sink.flush?.() ?? Promise.resolve();
  const logger = createLogger({ name: 'cifn', level: 'info', now: () => new Date(delivery.event.ts),
    redaction: { allowlist: ['/ctx/eventId', '/ctx/runId', '/ctx/jobKey', '/ctx/stepKey', '/ctx/ordinal'] },
    onError: () => { failed = true; }, sinks: [guarded] });
  logger.info(delivery.event.msg, { eventId: delivery.eventId, runId: delivery.runId,
    jobKey: delivery.jobKey, stepKey: delivery.event.ctx.stepKey, ordinal: delivery.ordinal });
  try { await logger.flush(); } catch { failed = true; }
  if (!emitted || failed) throw new Error('CiFn step output outcome requires reconciliation');
}

/** One bounded run page and one event per run per tick; callers must traverse returned cursors. */
export class LogFnStepOutputDispatcher {
  private active?: Promise<{ nextCursor?: string; delivered: number }>;
  private closed = false;
  constructor(private readonly store: DatabaseStore, private readonly sink: Sink, private readonly leaseMs = 60_000) {
    if (typeof sink !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error('Invalid LogFn step output dispatcher configuration');
  }
  tick(cursor?: string): Promise<{ nextCursor?: string; delivered: number }> {
    if (this.closed) return Promise.reject(new Error('LogFn step output dispatcher is closed'));
    if (this.active) return Promise.reject(new Error('LogFn step output dispatch already active'));
    const operation = this.dispatch(cursor); this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; }).catch(() => {});
    return operation;
  }
  private async dispatch(cursor?: string): Promise<{ nextCursor?: string; delivered: number }> {
    const page = await this.store.listStepOutputRuns(cursor); let delivered = 0;
    for (const runId of page.runIds) {
      if (this.closed) break;
      const claim = await this.store.claimStepOutput(runId, Date.now(), this.leaseMs);
      if (!claim) continue;
      let outcome: 'delivered' | 'unknown' = 'unknown';
      try { await deliverStepOutput(claim, this.sink); outcome = 'delivered'; } catch { /* Only sanitized ambiguity is persisted. */ }
      const now = Date.now();
      const recorded = await this.store.finishStepOutput(runId, claim.dispatchId, claim.eventId, claim.token, outcome, now);
      if (!recorded) throw new Error('CiFn step output receipt could not be committed');
      if (outcome === 'delivered' && now < claim.claimExpiresAt && now < claim.payloadExpiresAt) delivered++;
    }
    return { nextCursor: page.nextCursor, delivered };
  }
  /** Caller owns sink deadlines; close joins admitted I/O and never silently abandons it. */
  async close(): Promise<void> { this.closed = true; await this.active; }
}
