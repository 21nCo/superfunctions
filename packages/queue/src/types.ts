/** Lifecycle state of a stored job. Acknowledged jobs are removed, so they have no state. */
export type QueueJobState = 'pending' | 'leased' | 'dead';

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes claimable. Defaults to 0. */
  delayMs?: number;
  /**
   * While a job with the same key is pending or leased in the same queue, a
   * second enqueue is a no-op that returns the existing job's id.
   */
  dedupeKey?: string;
}

export interface EnqueueResult {
  id: string;
  /** True when the enqueue was a no-op because of `dedupeKey`. */
  deduplicated: boolean;
}

export interface ClaimOptions {
  /** How long the claimer holds the job before it becomes claimable again. */
  leaseMs: number;
}

export interface ClaimedJob<TPayload> {
  id: string;
  payload: TPayload;
  /** 1 on the first claim; incremented by every later claim, including one after an expired lease. */
  attempt: number;
}

/**
 * Optional fence for `ack`, `fail` and `extendLease`. When `attempt` is the
 * value returned by `claim`, the call only succeeds while that same claim
 * still holds the job, so a claimer whose lease expired and was reclaimed
 * cannot act on the new claimer's lease.
 */
export interface LeaseFence {
  attempt?: number;
}

export type FailOptions =
  | ({ retryAt: Date | number; reason?: string } & LeaseFence)
  | ({ deadLetter: true; reason: string } & LeaseFence);

export interface QueueJob<TPayload> {
  id: string;
  queue: string;
  payload: TPayload;
  state: QueueJobState;
  attempt: number;
  availableAt: Date;
  leaseUntil: Date | null;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueAdapter<TPayload> {
  enqueue(queueName: string, payload: TPayload, options?: EnqueueOptions): Promise<EnqueueResult>;
  /** Atomically leases the next available job, or resolves `null` when none is available. */
  claim(queueName: string, options: ClaimOptions): Promise<ClaimedJob<TPayload> | null>;
  /** Completes a leased job and removes it. Rejects with `FLOWFN_QUEUE_JOB_NOT_LEASED` otherwise. */
  ack(id: string, fence?: LeaseFence): Promise<void>;
  /** Releases a leased job for a retry at `retryAt`, or moves it to the dead-letter state. */
  fail(id: string, options: FailOptions): Promise<void>;
  /** Sets the lease of a leased job to expire `leaseMs` from now. */
  extendLease(id: string, leaseMs: number, fence?: LeaseFence): Promise<void>;
  /** Lists up to `limit` pending or leased jobs in claim order without changing them. */
  peek(queueName: string, limit: number): Promise<QueueJob<TPayload>[]>;
  /** Counts pending and leased jobs. */
  size(queueName: string): Promise<number>;
}
