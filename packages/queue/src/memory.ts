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

interface MemoryQueueIndex<TPayload> {
  /** Pending and leased jobs of one queue, keyed by id. */
  jobs: Map<number, MemoryJob<TPayload>>;
  /** The job holding each dedupe key in that queue. */
  dedupe: Map<string, MemoryJob<TPayload>>;
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
  // Per-queue indexes keep enqueue O(1) and queues isolated from each other's backlogs.
  private readonly queues = new Map<string, MemoryQueueIndex<TPayload>>();
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

    const existing = this.queues.get(queue);
    const duplicate = dedupeKey === null ? undefined : existing?.dedupe.get(dedupeKey);
    if (duplicate) {
      return { id: String(duplicate.id), deduplicated: true };
    }
    if (this.maxSize !== undefined && (existing?.jobs.size ?? 0) >= this.maxSize) {
      throw new QueueError('FLOWFN_QUEUE_FULL');
    }

    const id = this.nextId++;
    const job: MemoryJob<TPayload> = {
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
    };
    const index = existing ?? { jobs: new Map(), dedupe: new Map() };
    this.queues.set(queue, index);
    this.jobs.set(id, job);
    index.jobs.set(id, job);
    if (dedupeKey !== null) {
      index.dedupe.set(dedupeKey, job);
    }
    return { id: String(id), deduplicated: false };
  }

  async claim(queueName: string, options: ClaimOptions): Promise<ClaimedJob<TPayload> | null> {
    const queue = normalizeQueueName(queueName);
    const leaseMs = normalizeLeaseMs(options?.leaseMs);
    const now = readClock(this.now);

    let next: MemoryJob<TPayload> | undefined;
    for (const job of this.queues.get(queue)?.jobs.values() ?? []) {
      if (isClaimable(job, now) && (!next || compareClaimOrder(job, next) < 0)) {
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
    this.remove(job);
  }

  async fail(id: string, options: FailOptions): Promise<void> {
    const normalized = normalizeFailOptions(options);
    const job = this.requireLeased(id, normalized.attempt);
    if (normalized.kind === 'dead') {
      this.remove(job);
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
    return [...(this.queues.get(queue)?.jobs.values() ?? [])]
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
    return this.queues.get(queue)?.jobs.size ?? 0;
  }

  private remove(job: MemoryJob<TPayload>): void {
    this.jobs.delete(job.id);
    const index = this.queues.get(job.queue);
    if (!index) {
      return;
    }
    index.jobs.delete(job.id);
    if (job.dedupeKey !== null) {
      index.dedupe.delete(job.dedupeKey);
    }
    if (index.jobs.size === 0) {
      this.queues.delete(job.queue);
    }
  }

  private requireLeased(id: string, attempt: number | null): MemoryJob<TPayload> {
    const job = this.jobs.get(normalizeJobId(id));
    if (!job || job.state !== 'leased' || (attempt !== null && job.attempt !== attempt)) {
      throw new QueueError('FLOWFN_QUEUE_JOB_NOT_LEASED');
    }
    return job;
  }
}
