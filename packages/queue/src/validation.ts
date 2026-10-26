import type { EnqueueOptions, FailOptions, LeaseFence } from './types.js';

export class QueueError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'QueueError';
    this.code = code;
  }
}

const MAX_DEDUPE_KEY_LENGTH = 512;
/** Upper bound for `delayMs` and `leaseMs` (100 years), so `now + duration` stays a valid Date. */
const MAX_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;
/** The largest epoch-millisecond value a Date can hold. */
const MAX_TIMESTAMP_MS = 8.64e15;

export function normalizeQueueName(queueName: string): string {
  const normalized = typeof queueName === 'string' ? queueName.trim() : '';
  if (!normalized || normalized.includes('/') || normalized.includes('\\') || normalized.includes('..')) {
    throw new QueueError('FLOWFN_QUEUE_NAME_INVALID');
  }
  return normalized;
}

export interface NormalizedEnqueueOptions {
  delayMs: number;
  dedupeKey: string | null;
}

export function normalizeEnqueueOptions(options: EnqueueOptions | undefined): NormalizedEnqueueOptions {
  const delayMs = options?.delayMs ?? 0;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_DURATION_MS) {
    throw new QueueError('FLOWFN_QUEUE_DELAY_INVALID');
  }
  const dedupeKey = options?.dedupeKey;
  if (
    dedupeKey !== undefined &&
    (typeof dedupeKey !== 'string' || dedupeKey.length === 0 || dedupeKey.length > MAX_DEDUPE_KEY_LENGTH)
  ) {
    throw new QueueError('FLOWFN_QUEUE_DEDUPE_KEY_INVALID');
  }
  return { delayMs, dedupeKey: dedupeKey ?? null };
}

export function normalizeLeaseMs(leaseMs: unknown): number {
  if (typeof leaseMs !== 'number' || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_DURATION_MS) {
    throw new QueueError('FLOWFN_QUEUE_LEASE_INVALID');
  }
  return leaseMs;
}

export function normalizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new QueueError('FLOWFN_QUEUE_LIMIT_INVALID');
  }
  return limit;
}

/** Job ids are positive decimal integers rendered as strings. */
export function normalizeJobId(id: unknown): number {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
    throw new QueueError('FLOWFN_QUEUE_JOB_ID_INVALID');
  }
  const value = Number(id);
  if (!Number.isSafeInteger(value)) {
    throw new QueueError('FLOWFN_QUEUE_JOB_ID_INVALID');
  }
  return value;
}

export function normalizeFence(fence: LeaseFence | undefined): number | null {
  const attempt = fence?.attempt;
  if (attempt === undefined) {
    return null;
  }
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new QueueError('FLOWFN_QUEUE_ATTEMPT_INVALID');
  }
  return attempt;
}

export type NormalizedFailOptions =
  | { kind: 'retry'; retryAt: number; reason: string | null; attempt: number | null }
  | { kind: 'dead'; reason: string; attempt: number | null };

export function normalizeFailOptions(options: FailOptions): NormalizedFailOptions {
  if (!options || typeof options !== 'object') {
    throw new QueueError('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
  }
  const attempt = normalizeFence(options);
  if ('deadLetter' in options && 'retryAt' in options) {
    throw new QueueError('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
  }
  if ('deadLetter' in options) {
    if (options.deadLetter !== true || typeof options.reason !== 'string' || options.reason.length === 0) {
      throw new QueueError('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
    }
    return { kind: 'dead', reason: options.reason, attempt };
  }
  if (!('retryAt' in options)) {
    throw new QueueError('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
  }
  const retryAt = options.retryAt instanceof Date ? options.retryAt.getTime() : options.retryAt;
  if (typeof retryAt !== 'number' || !Number.isSafeInteger(retryAt) || retryAt < 0 || retryAt > MAX_TIMESTAMP_MS) {
    throw new QueueError('FLOWFN_QUEUE_RETRY_AT_INVALID');
  }
  if (options.reason !== undefined && typeof options.reason !== 'string') {
    throw new QueueError('FLOWFN_QUEUE_FAIL_OPTIONS_INVALID');
  }
  return { kind: 'retry', retryAt, reason: options.reason ?? null, attempt };
}

export function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS - MAX_DURATION_MS) {
    throw new QueueError('FLOWFN_QUEUE_CLOCK_INVALID');
  }
  return value;
}
