import { createHash } from 'node:crypto';
import { LOG_MAX_EVENTS, type LogLedger, type RunnerLogEvent } from './protocol.js';

export interface StepOutputClaim {
  eventId: string; ordinal: number; token: string; expiresAt: number; state: 'sending' | 'unknown';
}
/** Constant-sized receipt metadata; the prefix is never discarded while output can be replayed. */
export interface StepOutputCheckpoint {
  version: 1; delivered: number; claim?: StepOutputClaim;
  expired?: { at: number; undelivered: number; historicalCountUnavailable?: true };
}
export interface StepOutputDelivery {
  runId: string; dispatchId: string; jobKey: string; eventId: string; ordinal: number;
  token: string; claimExpiresAt: number; payloadExpiresAt: number; event: RunnerLogEvent;
}
export function stepOutputCheckpoint(ledger: LogLedger): StepOutputCheckpoint {
  const value = ledger.forwarding ??= { version: 1, delivered: 0, ...(ledger.status === 'expired' ? { expired: { at: ledger.expiresAt, undelivered: 0, historicalCountUnavailable: true as const } } : {}) };
  if (value.version !== 1 || !Number.isSafeInteger(value.delivered) || value.delivered < 0 || value.delivered > LOG_MAX_EVENTS ||
    (value.claim && (value.claim.ordinal !== value.delivered || !['sending', 'unknown'].includes(value.claim.state) ||
      !/^[a-f0-9]{64}$/.test(value.claim.eventId) || typeof value.claim.token !== 'string' || value.claim.token.length > 64 ||
      !Number.isSafeInteger(value.claim.expiresAt) || value.claim.expiresAt < 0)) ||
    (value.expired && (!Number.isSafeInteger(value.expired.at) || value.expired.at < 0 || !Number.isSafeInteger(value.expired.undelivered) || value.expired.undelivered < 0 || value.expired.undelivered + value.delivered + (value.claim ? 1 : 0) > LOG_MAX_EVENTS))) throw new Error('Invalid step output checkpoint');
  return value;
}
export function stepOutputId(namespace: string, runId: string, dispatchId: string, ordinal: number): string {
  return createHash('sha256').update(JSON.stringify(['cifn-step-output-v1', namespace, runId, dispatchId, ordinal])).digest('hex');
}
/** Payload retention always wins; unresolved effects retain identity, never secret-bearing output. */
export function expireLogLedger(ledger: LogLedger, now: number): void {
  if (ledger.status === 'expired') return;
  const receipt = stepOutputCheckpoint(ledger);
  if (receipt.claim) receipt.claim.state = 'unknown';
  receipt.expired = { at: now, undelivered: Math.max(0, ledger.eventCount - receipt.delivered - (receipt.claim ? 1 : 0)) };
  ledger.status = 'expired'; ledger.packets = []; ledger.bytes = 0; ledger.eventCount = 0;
}
