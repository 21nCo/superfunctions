import type {
  ClaimOptions,
  ClaimedJob,
  EnqueueOptions,
  EnqueueResult,
  FailOptions,
  LeaseFence,
  QueueAdapter,
  QueueJob,
  QueueJobState,
} from './types.js';
import {
  QueueError,
  normalizeEnqueueOptions,
  normalizeFailOptions,
  normalizeFence,
  normalizeJobId,
  normalizeLeaseMs,
  normalizeLimit,
  normalizeQueueName,
  readClock,
} from './validation.js';

export interface MemoryQueueAdapterOptions {
  /**
   * Maximum number of pending and leased jobs retained per queue. When
   * reached, further `enqueue` calls reject with `FLOWFN_QUEUE_FULL` instead
   * of growing without bound. Unset means unbounded.
   */
  maxSize?: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface MemoryJob<TPayload> {
  id: number;
  queue: string;
  payload: TPayload;
  state: Exclude<QueueJobState, 'dead'>;
  attempt: number;
  availableAt: number;
  leaseUntil: number | null;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function isClaimable(job: MemoryJob<unknown>, now: number): boolean {
  return job.state === 'pending' ? job.availableAt <= now : (job.leaseUntil as number) <= now;
}

function compareClaimOrder(a: MemoryJob<unknown>, b: MemoryJob<unknown>): number {
  return a.availableAt - b.availableAt || a.id - b.id;
}

/**
 * Process-local queue for tests and single-process use. Jobs do not survive a
 * restart, and dead-lettered jobs are discarded; use `DatabaseQueueAdapter`
 * for durable storage.
 */
export class MemoryQueueAdapter<TPayload> implements QueueAdapter<TPayload> {
  private readonly jobs = new Map<number, MemoryJob<TPayload>>();
  private readonly maxSize?: number;
  private readonly now: () => number;
  private nextId = 1;

  constructor(options: MemoryQueueAdapterOptions = {}) {
    if (options.maxSize !== undefined) {
      if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
        throw new QueueError('FLOWFN_QUEUE_MAX_SIZE_INVALID');
      }
    }
    this.maxSize = options.maxSize;
    this.now = options.now ?? Date.now;
  }

  async enqueue(queueName: string, payload: TPayload, options?: EnqueueOptions): Promise<EnqueueResult> {
    const queue = normalizeQueueName(queueName);
    const { delayMs, dedupeKey } = normalizeEnqueueOptions(options);
    const now = readClock(this.now);

    let live = 0;
    for (const job of this.jobs.values()) {
      if (job.queue !== queue) {
        continue;
      }
      if (dedupeKey !== null && job.dedupeKey === dedupeKey) {
        return { id: String(job.id), deduplicated: true };
      }
      live += 1;
    }
    if (this.maxSize !== undefined && live >= this.maxSize) {
      throw new QueueError('FLOWFN_QUEUE_FULL');
    }

    const id = this.nextId++;
    this.jobs.set(id, {
      id,
      queue,
      payload,
      state: 'pending',
      attempt: 0,
      availableAt: now + delayMs,
      leaseUntil: null,
      dedupeKey,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    return { id: String(id), deduplicated: false };
  }

  async claim(queueName: string, options: ClaimOptions): Promise<ClaimedJob<TPayload> | null> {
    const queue = normalizeQueueName(queueName);
    const leaseMs = normalizeLeaseMs(options?.leaseMs);
    const now = readClock(this.now);

    let next: MemoryJob<TPayload> | undefined;
    for (const job of this.jobs.values()) {
      if (job.queue === queue && isClaimable(job, now) && (!next || compareClaimOrder(job, next) < 0)) {
        next = job;
      }
    }
    if (!next) {
      return null;
    }

    next.state = 'leased';
    next.attempt += 1;
    next.leaseUntil = now + leaseMs;
    next.updatedAt = now;
    return { id: String(next.id), payload: next.payload, attempt: next.attempt };
  }

  async ack(id: string, fence?: LeaseFence): Promise<void> {
    const job = this.requireLeased(id, normalizeFence(fence));
    this.jobs.delete(job.id);
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    const normalized = normalizeFailOptions(options);
    const job = this.requireLeased(id, normalized.attempt);
    if (normalized.kind === 'dead') {
      this.jobs.delete(job.id);
      return;
    }
    job.state = 'pending';
    job.availableAt = normalized.retryAt;
    job.leaseUntil = null;
    job.lastError = normalized.reason;
    job.updatedAt = readClock(this.now);
  }

  async extendLease(id: string, leaseMs: number, fence?: LeaseFence): Promise<void> {
    const normalizedLeaseMs = normalizeLeaseMs(leaseMs);
    const job = this.requireLeased(id, normalizeFence(fence));
    const now = readClock(this.now);
    job.leaseUntil = now + normalizedLeaseMs;
    job.updatedAt = now;
  }

  async peek(queueName: string, limit: number): Promise<QueueJob<TPayload>[]> {
    const queue = normalizeQueueName(queueName);
    const normalizedLimit = normalizeLimit(limit);
    return [...this.jobs.values()]
      .filter((job) => job.queue === queue)
      .sort(compareClaimOrder)
      .slice(0, normalizedLimit)
      .map((job) => ({
        id: String(job.id),
        queue: job.queue,
        payload: job.payload,
        state: job.state,
        attempt: job.attempt,
        availableAt: new Date(job.availableAt),
        leaseUntil: job.leaseUntil === null ? null : new Date(job.leaseUntil),
        dedupeKey: job.dedupeKey,
        lastError: job.lastError,
        createdAt: new Date(job.createdAt),
        updatedAt: new Date(job.updatedAt),
      }));
  }

  async size(queueName: string): Promise<number> {
    const queue = normalizeQueueName(queueName);
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.queue === queue) {
        count += 1;
      }
    }
    return count;
  }

  private requireLeased(id: string, attempt: number | null): MemoryJob<TPayload> {
    const job = this.jobs.get(normalizeJobId(id));
    if (!job || job.state !== 'leased' || (attempt !== null && job.attempt !== attempt)) {
      throw new QueueError('FLOWFN_QUEUE_JOB_NOT_LEASED');
    }
    return job;
  }
}
